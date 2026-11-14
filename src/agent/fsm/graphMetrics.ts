/**
 * Non-invasive metrics collection for FSM graph benchmark scenarios.
 *
 * Wraps the same seams the scenario tests already own — the injected
 * StreamChatFn / fake-host methods — and derives structural counters from
 * `FSMGraphRunResult.nodesVisited`. Never touches kernel code; safe for
 * node --test (no electron import). Part of the graph benchmark suite:
 * docs/plans/20260827-fsm-graph-benchmark-suite.md.
 */
import type { StreamChatFn } from "../types.js";
import type {
  OpenAiCompatibleClientConfig,
  StreamChatOptions,
} from "../../llm/types.js";
import type { StreamEvent } from "../../llm/streamEvents.js";
import { estimateTokensForRequest } from "../estimateTokens.js";
import type { FSMGraphRunResult } from "./types.js";
import type { FsmHostCapabilities } from "./FsmHostCapabilities.js";

/** Deterministic structural + prompt-size counters for one graph run. */
export type GraphRunMetrics = {
  /** Wrapped model round invocations (streamChat / streamModelRound). */
  modelCalls: number;
  /** Tool-call parts scripted or executed through the wrapped seams. */
  toolCalls: number;
  /** nodeId → enter count, derived from nodesVisited. */
  nodeVisits: Record<string, number>;
  /** Transitions between node enters (visits − 1). */
  edgeHops: number;
  /** Enter order straight from FSMGraphRunResult.nodesVisited. */
  visitOrder: string[];
  /**
   * Local gpt-tokenizer estimate of assembled request sizes — regression
   * comparison signal ONLY; not provider truth (project convention).
   */
  estPromptTokens: { total: number; maxCall: number };
};

export function emptyMetrics(): GraphRunMetrics {
  return {
    modelCalls: 0,
    toolCalls: 0,
    nodeVisits: {},
    edgeHops: 0,
    visitOrder: [],
    estPromptTokens: { total: 0, maxCall: 0 },
  };
}

function recordTokenEstimate(
  metrics: GraphRunMetrics,
  options: Pick<StreamChatOptions, "messages" | "tools">,
): void {
  const estimate = estimateTokensForRequest(options.messages ?? [], options.tools);
  metrics.estPromptTokens.total += estimate.raw;
  if (estimate.raw > metrics.estPromptTokens.maxCall) {
    metrics.estPromptTokens.maxCall = estimate.raw;
  }
}

/**
 * Wrap a StreamChatFn so every model round increments `modelCalls`, adds the
 * estimated request size, and records any tool-call delta the caller reports
 * via `onAssistantParts` (async generators must stay transparent otherwise).
 */
export function instrumentStreamChat(
  stream: StreamChatFn,
  metrics: GraphRunMetrics,
): StreamChatFn {
  const wrapped: StreamChatFn = async function* (
    config: OpenAiCompatibleClientConfig,
    options: StreamChatOptions,
  ): AsyncGenerator<StreamEvent, void, undefined> {
    metrics.modelCalls += 1;
    recordTokenEstimate(metrics, options);
    yield* stream(config, options);
  };
  return wrapped;
}

type StreamModelRoundLike = NonNullable<
  FsmHostCapabilities["streamModelRound"]
>;

type PrepareModelWindowLike = NonNullable<
  FsmHostCapabilities["prepareModelWindow"]
>;

type RunToolsPhaseLike = NonNullable<FsmHostCapabilities["runToolsPhase"]>;

/**
 * Wrap the fake-host seams used by scripted scenarios:
 * - streamModelRound → modelCalls++
 * - prepareModelWindow → token estimate from the assembled window
 * - runToolsPhase → toolCalls += requested count
 * All wrappers delegate unchanged; pass-through clones keep typing honest.
 */
export function instrumentFakeHost(
  host: FsmHostCapabilities,
  metrics: GraphRunMetrics,
): FsmHostCapabilities {
  const next: FsmHostCapabilities = { ...host };
  if (typeof host.streamModelRound === "function") {
    const inner = host.streamModelRound.bind(host);
    const wrapped: StreamModelRoundLike = async (...args) => {
      metrics.modelCalls += 1;
      // NOTE: tool-call COUNTING deliberately lives on runToolsPhase only —
      // counting here as well would double-report every scripted batch.
      return inner(...args);
    };
    next.streamModelRound = wrapped as typeof host.streamModelRound;
  }
  if (typeof host.prepareModelWindow === "function") {
    const inner = host.prepareModelWindow.bind(host);
    const wrapped: PrepareModelWindowLike = async (...args) => {
      const outcome = await inner(...args);
      const ok = outcome as { ok?: boolean; messages?: unknown[] };
      if (ok?.ok && Array.isArray(ok.messages)) {
        recordTokenEstimate(metrics, {
          messages: ok.messages as StreamChatOptions["messages"],
        });
      }
      return outcome;
    };
    next.prepareModelWindow = wrapped as typeof host.prepareModelWindow;
  }
  if (typeof host.runToolsPhase === "function") {
    const inner = host.runToolsPhase.bind(host);
    const wrapped: RunToolsPhaseLike = async (_assistant, toolCalls, ...rest) => {
      metrics.toolCalls += Array.isArray(toolCalls) ? toolCalls.length : 0;
      return inner(_assistant, toolCalls, ...rest);
    };
    next.runToolsPhase = wrapped as typeof host.runToolsPhase;
  }
  return next;
}

/** Collapse an FSMGraph.run result into structural metrics fields. */
export function collectStructure(
  result: Pick<FSMGraphRunResult, "nodesVisited">,
): Pick<GraphRunMetrics, "nodeVisits" | "edgeHops" | "visitOrder"> {
  const nodeVisits: Record<string, number> = {};
  for (const id of result.nodesVisited) {
    nodeVisits[id] = (nodeVisits[id] ?? 0) + 1;
  }
  return {
    nodeVisits,
    edgeHops: Math.max(0, result.nodesVisited.length - 1),
    visitOrder: [...result.nodesVisited],
  };
}

// ---------------------------------------------------------------------------
// Stable config fingerprint — keys baseline entries so legitimate graph edits
// (self-harness era) surface as missing entries, not spurious mismatches.
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit over a canonically serialized config; hex, 8 chars. */
export function configFingerprint(config: unknown): string {
  const canonical = canonicalize(config);
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
