export type LintSeverity = "error" | "warn";

export type LintFinding = {
  path: string;
  message: string;
  line?: number;
  column?: number;
  severity?: LintSeverity;
  code?: string;
};

export type LintContext = {
  readonly root: string;
  readonly files: readonly string[];
  readFile(path: string): Promise<string>;
  report(finding: LintFinding): void;
};

export type LintRule = {
  readonly id: string;
  readonly title: string;
  readonly severity: LintSeverity;
  readonly include?: readonly string[];
  check(context: LintContext): void | Promise<void>;
};

export type LintDiagnostic = {
  ruleId: string;
  severity: LintSeverity;
  path: string;
  line: number | null;
  column: number | null;
  message: string;
  code: string | null;
};
