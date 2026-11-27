import assert from "node:assert/strict";
import test from "node:test";
import type { LintRunResult } from "./engine.js";
import { exitCodeForResult, formatDiagnostic, summarizeRun } from "./report.js";
import { parseArgs } from "./cli.js";
import { parseBuildDiagnostic } from "../renderer/src/devmode/buildDiagnostics.js";

function runResult(overrides: Partial<LintRunResult>): LintRunResult {
  return {
    ruleCount: 0,
    fileCount: 0,
    diagnostics: [],
    errorCount: 0,
    warningCount: 0,
    missingTargets: [],
    scoped: false,
    ...overrides,
  };
}

test("diagnostics print in the shape the Problems panel already parses", () => {
  assert.equal(
    formatDiagnostic({ ruleId: "no-todo", severity: "warn", path: "src/a.ts", line: 3, column: 5, message: "TODO marker", code: null }),
    "src/a.ts:3:5: warning: [no-todo] TODO marker",
  );
  assert.equal(
    formatDiagnostic({ ruleId: "no-todo", severity: "error", path: "src/a.ts", line: 3, column: null, message: "TODO marker", code: "T1" }),
    "src/a.ts:3:1: error: [no-todo/T1] TODO marker",
  );
  assert.equal(
    formatDiagnostic({ ruleId: "no-todo", severity: "warn", path: "src/a.ts", line: null, column: null, message: "file level", code: null }),
    "src/a.ts: warning: [no-todo] file level",
  );
});

test("the summary states scope, counts and rule/file totals", () => {
  const result = runResult({ ruleCount: 1, fileCount: 2, errorCount: 1, scoped: true, diagnostics: [
    { ruleId: "a", severity: "error", path: "src/a.ts", line: 1, column: 1, message: "x", code: null },
  ] });
  assert.equal(summarizeRun(result), "1 problem · (1 error, 0 warnings) · 1 rule · 2 files · selected files");
  assert.equal(summarizeRun(runResult({})), "0 problems · (0 errors, 0 warnings) · 0 rules · 0 files · whole workspace");
});

test("only error-level findings fail the run, unmatched targets are a usage error", () => {
  assert.equal(exitCodeForResult(runResult({ warningCount: 3 })), 0);
  assert.equal(exitCodeForResult(runResult({ errorCount: 1 })), 1);
  assert.equal(exitCodeForResult(runResult({ missingTargets: ["nope.ts"] })), 2);
});

test("the Build panel diagnostics parser reads formatted findings back", () => {
  const warning = parseBuildDiagnostic(
    formatDiagnostic({ ruleId: "no-todo", severity: "warn", path: "src/a.ts", line: 3, column: 5, message: "TODO marker", code: null }),
  )!;
  assert.equal(warning.severity, "warning");
  assert.equal(warning.path, "src/a.ts");
  assert.equal(warning.line, 3);
  assert.equal(warning.column, 5);
  assert.match(warning.message, /\[no-todo\] TODO marker/);
  const error = parseBuildDiagnostic(
    formatDiagnostic({ ruleId: "no-todo", severity: "error", path: "src/b.ts", line: 9, column: 2, message: "boom", code: null }),
  )!;
  assert.equal(error.severity, "error");
  assert.equal(error.line, 9);
  assert.equal(parseBuildDiagnostic(summarizeRun(runResult({}))), null, "the summary line is not a diagnostic");
});

test("CLI arguments separate the rules directory from the files to lint", () => {
  const parsed = parseArgs(["--rules-dir", "tools/rules", "src/lint", "src/a.ts"], "/repo");
  assert.equal(parsed.rulesDir, "/repo/tools/rules");
  assert.equal(parsed.root, "/repo");
  assert.deepEqual(parsed.targets, ["src/lint", "src/a.ts"]);
  const defaults = parseArgs([], "/repo");
  assert.equal(defaults.rulesDir, "/repo/src/lint/rules");
  assert.deepEqual(defaults.targets, []);
  assert.throws(() => parseArgs(["--nope"], "/repo"), /unknown option/);
});
