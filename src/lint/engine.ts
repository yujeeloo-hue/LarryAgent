import { includeMatches } from "./glob.js";
import { loadRules } from "./registry.js";
import {
  collectWorkspaceFiles,
  createFileReader,
  normalizePath,
  selectFiles,
  toRelativePath,
} from "./workspace.js";
import type { LintContext, LintDiagnostic, LintFinding, LintRule, LintSeverity } from "./types.js";

export type LintRunOptions = {
  root: string;
  rulesDir: string;
  targets?: readonly string[];
};

export type LintRunResult = {
  ruleCount: number;
  fileCount: number;
  diagnostics: LintDiagnostic[];
  errorCount: number;
  warningCount: number;
  missingTargets: string[];
  scoped: boolean;
};

function clampPosition(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

function toDiagnostic(root: string, rule: LintRule, finding: LintFinding): LintDiagnostic {
  if (!finding || typeof finding.message !== "string" || !finding.message.trim()) {
    throw new Error(`rule "${rule.id}" reported a finding without a message`);
  }
  if (typeof finding.path !== "string" || !finding.path.trim()) {
    throw new Error(`rule "${rule.id}" reported a finding without a path`);
  }
  const severity: LintSeverity = finding.severity ?? rule.severity;
  const code = finding.code?.trim();
  return {
    ruleId: rule.id,
    severity: severity === "error" ? "error" : "warn",
    path: toRelativePath(root, normalizePath(finding.path)),
    line: clampPosition(finding.line),
    column: clampPosition(finding.column),
    message: finding.message.trim(),
    code: code ? code : null,
  };
}

function compareDiagnostics(a: LintDiagnostic, b: LintDiagnostic): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if ((a.line ?? 0) !== (b.line ?? 0)) return (a.line ?? 0) - (b.line ?? 0);
  if ((a.column ?? 0) !== (b.column ?? 0)) return (a.column ?? 0) - (b.column ?? 0);
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  if (a.message === b.message) return 0;
  return a.message < b.message ? -1 : 1;
}

function ruleFailure(rule: LintRule, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error);
  return new Error(`lint rule "${rule.id}" failed: ${detail}`, { cause: error });
}

export async function runLint(options: LintRunOptions): Promise<LintRunResult> {
  const root = options.root;
  const scoped = Boolean(options.targets && options.targets.length > 0);
  const rules = await loadRules(options.rulesDir);
  const available = await collectWorkspaceFiles(root);
  const selection = scoped ? await selectFiles(root, available, options.targets ?? []) : { files: available, missing: [] };
  const files = selection.files;
  const readFile = createFileReader(root);
  const diagnostics: LintDiagnostic[] = [];
  const seen = new Set<string>();
  for (const rule of rules) {
    const scopedFiles = files.filter((file) => includeMatches(file, rule.include));
    const context: LintContext = {
      root,
      files: scopedFiles,
      readFile,
      report: (finding) => {
        const item = toDiagnostic(root, rule, finding);
        const key = JSON.stringify([item.ruleId, item.path, item.line, item.column, item.message]);
        if (seen.has(key)) return;
        seen.add(key);
        diagnostics.push(item);
      },
    };
    try {
      await rule.check(context);
    } catch (error) {
      throw ruleFailure(rule, error);
    }
  }
  diagnostics.sort(compareDiagnostics);
  return {
    ruleCount: rules.length,
    fileCount: files.length,
    diagnostics,
    errorCount: diagnostics.filter((item) => item.severity === "error").length,
    warningCount: diagnostics.filter((item) => item.severity === "warn").length,
    missingTargets: selection.missing,
    scoped,
  };
}
