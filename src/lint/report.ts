import type { LintRunResult } from "./engine.js";
import type { LintDiagnostic } from "./types.js";

export function formatDiagnostic(item: LintDiagnostic): string {
  const severity = item.severity === "error" ? "error" : "warning";
  const name = item.code ? `[${item.ruleId}/${item.code}]` : `[${item.ruleId}]`;
  const location = item.line === null ? item.path : `${item.path}:${item.line}:${item.column ?? 1}`;
  return `${location}: ${severity}: ${name} ${item.message}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function summarizeRun(result: LintRunResult): string {
  const scope = result.scoped ? "selected files" : "whole workspace";
  return [
    plural(result.diagnostics.length, "problem"),
    `(${plural(result.errorCount, "error")}, ${plural(result.warningCount, "warning")})`,
    plural(result.ruleCount, "rule"),
    plural(result.fileCount, "file"),
    scope,
  ].join(" · ");
}

export function exitCodeForResult(result: LintRunResult): number {
  if (result.missingTargets.length > 0) return 2;
  return result.errorCount > 0 ? 1 : 0;
}
