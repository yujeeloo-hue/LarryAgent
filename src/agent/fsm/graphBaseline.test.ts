/**
 * Metrics baseline suite — FSM graph benchmark step 2.
 *
 * Single authority for efficiency regression (Review inventory #1):
 * structural counters (modelCalls / toolCalls / edgeHops / nodeVisits /
 * visitOrder) AND prompt-size estimates (estPromptTokens) are compared
 * against git-tracked `__fixtures__/graph-metrics-baseline.json`.
 *
 * Failure modes, each naming its remedy:
 * - MISSING ENTRY   — new/renamed scenario without a baseline row.
 * - FINGERPRINT     — graph config changed (self-harness edit or factory
 *                     change): identity drifted, counts are not comparable.
 * - METRIC DRIFT    — table of expected vs actual, engine got cheaper or
 *                     more expensive; intentional changes are adopted via:
 *
 *   UPDATE_BASELINE=1 node --import tsx --test src/agent/fsm/graphBaseline.test.ts
 *
 * wallMs is REPORT-ONLY (never asserted): median of BASELINE_ITERATIONS
 * (default 5) runs, mock-level timing is far too noisy to gate on.
 *
 * Run commands:
 * - Full regression (this suite rides along):
 *     find src -name "*.test.ts" | xargs node --import tsx --test
 * - Behavior assertions only: src/agent/fsm/graphScenarios.test.ts
 * - Baseline only (drift gate):
 *     node --import tsx --test src/agent/fsm/graphBaseline.test.ts
 * - Refresh baseline after an intentional optimization: see UPDATE above.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { IS_WINDOWS } from "../../platformCaps.js";
import {
  SCENARIOS,
  SCENARIO_NAMES,
  disposeBenchmarkEnv,
  initBenchmarkEnv,
  type ScenarioOutcome,
} from "./graphScenarios.js";

const BASELINE_PATH = fileURLToPath(
  new URL("./__fixtures__/graph-metrics-baseline.json", import.meta.url),
);
const UPDATE = process.env.UPDATE_BASELINE === "1";
const ITERATIONS = Math.max(1, Number(process.env.BASELINE_ITERATIONS ?? 5));

/** Compared metrics — the complete authority set, nothing asserted inline. */
type BaselineMetrics = {
  modelCalls: number;
  toolCalls: number;
  edgeHops: number;
  nodeVisits: Record<string, number>;
  estPromptTokens: { total: number; maxCall: number };
  visitOrder: string[];
};

type BaselineEntry = {
  /** Config content hash — detects graph edits that invalidate comparability. */
  fingerprint: string;
  metrics: BaselineMetrics;
};

type BaselineFile = {
  _meta: {
    description: string;
    updateCommand: string;
    generatedAt: string;
  };
  entries: Record<string, BaselineEntry>;
};

const UPDATE_COMMAND =
  "UPDATE_BASELINE=1 node --import tsx --test src/agent/fsm/graphBaseline.test.ts";

// Platform-dependent prompt text (tool descriptions, shell examples) shifts
// estPromptTokens by a few tokens between macOS and Windows while graph
// structure stays identical. Windows baseline rows live under a "@win32"
// suffixed key; the bare key stays the macOS authority. UPDATE mode merges,
// so regenerating on one platform never drops the other's rows.
const PLATFORM_KEY_SUFFIX = IS_WINDOWS ? "@win32" : "";
const platformKey = (name: string): string => name + PLATFORM_KEY_SUFFIX;
const stripPlatformSuffix = (key: string): string =>
  key.replace(/@(win32|darwin|linux)$/, "");

before(async () => {
  await initBenchmarkEnv();
});

after(async () => {
  await disposeBenchmarkEnv();
});

function toBaselineMetrics(outcome: ScenarioOutcome): BaselineMetrics {
  return {
    modelCalls: outcome.metrics.modelCalls,
    toolCalls: outcome.metrics.toolCalls,
    edgeHops: outcome.metrics.edgeHops,
    nodeVisits: outcome.metrics.nodeVisits,
    estPromptTokens: outcome.metrics.estPromptTokens,
    visitOrder: outcome.metrics.visitOrder,
  };
}

/** Repeated timed runs keep the last outcome; samples feed the report only. */
async function timedScenario(name: string): Promise<{
  outcome: ScenarioOutcome;
  samplesMs: number[];
}> {
  const samplesMs: number[] = [];
  let outcome: ScenarioOutcome | null = null;
  for (let i = 0; i < ITERATIONS; i += 1) {
    const started = performance.now();
    outcome = await SCENARIOS[name]!();
    samplesMs.push(performance.now() - started);
  }
  assert.ok(outcome, `scenario ${name} produced no outcome`);
  return { outcome, samplesMs };
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid]! + sorted[mid - 1]!) / 2;
}

function readBaseline(): BaselineFile | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineFile;
  } catch {
    return null;
  }
}

function buildFreshBaseline(): BaselineFile {
  return {
    _meta: {
      description:
        "FSM benchmark structural/token baseline — regenerated ONLY via the command below.",
      updateCommand: UPDATE_COMMAND,
      generatedAt: new Date().toISOString(),
    },
    entries: {},
  };
}

// ---------------------------------------------------------------------------
// WRITE MODE — regenerate the whole fixture from live runs and stop failing.
// ---------------------------------------------------------------------------

if (UPDATE) {
  describe("FSM graph baseline — UPDATE mode", () => {
    it("rewrites the baseline fixture from live scenario runs", async () => {
      const fresh = buildFreshBaseline();
      const existing = readBaseline();
      if (existing) Object.assign(fresh.entries, existing.entries);
      const timings: Array<[string, number]> = [];
      for (const name of SCENARIO_NAMES) {
        const { outcome, samplesMs } = await timedScenario(name);
        fresh.entries[platformKey(name)] = {
          fingerprint: outcome.fingerprint,
          metrics: toBaselineMetrics(outcome),
        };
        timings.push([name, median(samplesMs)]);
      }
      mkdirSync(dirname(BASELINE_PATH), { recursive: true });
      writeFileSync(
        BASELINE_PATH,
        `${JSON.stringify(fresh, null, 2)}\n`,
        "utf8",
      );
      console.log(`[baseline] written: ${BASELINE_PATH}`);
      // Informational timing report (report-only contract).
      for (const [name, med] of timings) {
        console.log(`[timing] ${name}: median ${med.toFixed(1)}ms`);
      }
    });
  });
} else {
  // -------------------------------------------------------------------------
  // COMPARE MODE — the regression gate.
  // -------------------------------------------------------------------------

  const baseline = readBaseline();
  const timingsAfterRun: Array<[string, number]> = [];

  function diffTable(
    name: string,
    expected: BaselineMetrics,
    actual: BaselineMetrics,
  ): string[] {
    const rows: string[] = [
      "",
      `Baseline drift in "${name}":`,
      "  metric                          expected         actual",
      "  ------------------------------- ---------------- ----------------",
    ];
    const scalar: Array<[string, string, string]> = [
      ["modelCalls", String(expected.modelCalls), String(actual.modelCalls)],
      ["toolCalls", String(expected.toolCalls), String(actual.toolCalls)],
      ["edgeHops", String(expected.edgeHops), String(actual.edgeHops)],
      [
        "estPromptTokens.total",
        String(expected.estPromptTokens.total),
        String(actual.estPromptTokens.total),
      ],
      [
        "estPromptTokens.maxCall",
        String(expected.estPromptTokens.maxCall),
        String(actual.estPromptTokens.maxCall),
      ],
    ];
    for (const [metric, exp, act] of scalar) {
      if (exp !== act) {
        rows.push(
          `  ${metric.padEnd(31)} ${exp.padStart(16)} ${act.padStart(17)}  ← drift`,
        );
      }
    }
    const nodeIds = new Set([
      ...Object.keys(expected.nodeVisits),
      ...Object.keys(actual.nodeVisits),
    ]);
    for (const id of nodeIds) {
      const exp = expected.nodeVisits[id] ?? 0;
      const act = actual.nodeVisits[id] ?? 0;
      if (exp !== act) {
        rows.push(
          `  ${`nodeVisits.${id}`.padEnd(31)} ${String(exp).padStart(16)} ${String(act).padStart(17)}  ← drift`,
        );
      }
    }
    if (
      expected.visitOrder.length === actual.visitOrder.length &&
      expected.visitOrder.some((id, i) => id !== actual.visitOrder[i])
    ) {
      rows.push("  visitOrder differs (same length):");
      rows.push(`    expected: ${expected.visitOrder.join(" → ")}`);
      rows.push(`    actual:   ${actual.visitOrder.join(" → ")}`);
    } else if (expected.visitOrder.length !== actual.visitOrder.length) {
      rows.push("  visitOrder length changed:");
      rows.push(`    expected (${expected.visitOrder.length}): ${expected.visitOrder.join(" → ")}`);
      rows.push(`    actual   (${actual.visitOrder.length}): ${actual.visitOrder.join(" → ")}`);
    }
    rows.push("");
    rows.push(`Intentional optimization? Adopt it explicitly:`);
    rows.push(`  ${UPDATE_COMMAND}`);
    return rows;
  }

  for (const name of SCENARIO_NAMES) {
    it(`${name} matches the committed efficiency baseline`, async () => {
      assert.ok(baseline, "baseline fixture missing entirely");
      const entry = baseline.entries[platformKey(name)] ?? baseline.entries[name];
      if (!entry) {
        assert.fail(
          [
            `MISSING baseline entry for "${name}".`,
            `Known remedy — regenerate the fixture:`,
            `  ${UPDATE_COMMAND}`,
          ].join("\n"),
        );
      }
      const { outcome, samplesMs } = await timedScenario(name);
      timingsAfterRun.push([name, median(samplesMs)]);

      if (entry.fingerprint !== outcome.fingerprint) {
        assert.fail(
          [
            `FINGERPRINT drift in "${name}" (${entry.fingerprint} → ${outcome.fingerprint}).`,
            `The graph config itself changed (self-harness edit or factory change);`,
            `previous counts are not comparable. Adopt explicitly:`,
            `  ${UPDATE_COMMAND}`,
          ].join("\n"),
        );
      }
      const actual = toBaselineMetrics(outcome);
      const expected = entry.metrics;
      const drifted =
        actual.modelCalls !== expected.modelCalls ||
        actual.toolCalls !== expected.toolCalls ||
        actual.edgeHops !== expected.edgeHops ||
        actual.estPromptTokens.total !== expected.estPromptTokens.total ||
        actual.estPromptTokens.maxCall !== expected.estPromptTokens.maxCall ||
        JSON.stringify(actual.nodeVisits) !== JSON.stringify(expected.nodeVisits) ||
        JSON.stringify(actual.visitOrder) !== JSON.stringify(expected.visitOrder);
      if (drifted) {
        assert.fail(diffTable(name, expected, actual).join("\n"));
      }
    });
  }

  it("every committed baseline entry maps to a live scenario", () => {
    assert.ok(baseline, "baseline fixture missing entirely");
    const orphaned = Object.keys(baseline.entries).filter(
      (key) => !SCENARIO_NAMES.includes(stripPlatformSuffix(key)),
    );
    assert.deepEqual(
      orphaned,
      [],
      `Stale baseline entries (scenario removed/renamed): ${orphaned.join(", ")}`,
    );
  });

  it("reports per-scenario wallMs medians (informational, never gating)", async () => {
    // Runs already happened in the per-scenario tests above; this block only
    // surfaces the report-only timing contract. Emits after comparisons so
    // the table doubles as the suite footer.
    for (const [name, med] of timingsAfterRun) {
      console.log(`[timing] ${name}: median ${med.toFixed(1)}ms`);
    }
    assert.ok(true);
  });
}
