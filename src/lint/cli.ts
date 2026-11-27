import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import { runLint } from "./engine.js";
import { exitCodeForResult, formatDiagnostic, summarizeRun } from "./report.js";

export const DEFAULT_RULES_DIR = "src/lint/rules";

const USAGE = [
  "Usage: npm run lint [-- <files|dirs|globs...>]",
  "",
  "  (no target)          lint the whole workspace",
  "  src/lint/engine.ts   lint one file",
  "  src/lint             lint a directory tree",
  "  \"src/**/*.ts\"        lint everything matching a glob",
  "",
  "  --root <path>        workspace root (default: cwd)",
  "  --rules-dir <path>   rule extension directory (default: src/lint/rules)",
  "  --help",
].join("\n");

export type LintCliOptions = {
  root: string;
  rulesDir: string;
  targets: string[];
  help: boolean;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseArgs(argv: readonly string[], cwd: string = process.cwd()): LintCliOptions {
  let root = cwd;
  let rulesDir: string | null = null;
  const targets: string[] = [];
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) throw new Error("--root needs a path");
      index += 1;
      root = resolve(cwd, value);
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = resolve(cwd, arg.slice("--root=".length));
      continue;
    }
    if (arg === "--rules-dir") {
      const value = argv[index + 1];
      if (!value) throw new Error("--rules-dir needs a path");
      index += 1;
      rulesDir = value;
      continue;
    }
    if (arg.startsWith("--rules-dir=")) {
      rulesDir = arg.slice("--rules-dir=".length);
      continue;
    }
    if (arg === "--") continue;
    if (arg.startsWith("-")) throw new Error(`unknown option "${arg}"`);
    targets.push(arg);
  }
  return {
    root,
    rulesDir: rulesDir ? resolve(root, rulesDir) : join(root, DEFAULT_RULES_DIR),
    targets,
    help,
  };
}

export async function main(argv: readonly string[], cwd: string = process.cwd()): Promise<number> {
  let options: LintCliOptions;
  try {
    options = parseArgs(argv, cwd);
  } catch (error) {
    console.error(`[lint] ${message(error)}`);
    return 2;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  try {
    const result = await runLint({
      root: options.root,
      rulesDir: options.rulesDir,
      ...(options.targets.length > 0 ? { targets: options.targets } : {}),
    });
    for (const item of result.diagnostics) console.log(formatDiagnostic(item));
    console.log(summarizeRun(result));
    if (result.missingTargets.length > 0) {
      console.error(`[lint] no files matched: ${result.missingTargets.join(", ")}`);
    }
    return exitCodeForResult(result);
  } catch (error) {
    console.error(`[lint] ${message(error)}`);
    return 2;
  }
}

const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(resolve(invoked)).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`[lint] ${message(error)}`);
      process.exitCode = 2;
    },
  );
}
