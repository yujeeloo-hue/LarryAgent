import type { LintContext, LintRule } from "../types.js";
import { isTestFile, maskLiterals, position } from "./_mask.js";

const SET_INTERVAL = /(?<![\w$.])(?:window\s*\.\s*|globalThis\s*\.\s*|self\s*\.\s*)?setInterval\s*\(/g;
const CLEAR_INTERVAL = /(?<![\w$.])(?:window\s*\.\s*|globalThis\s*\.\s*|self\s*\.\s*)?clearInterval\s*\(/;

async function check({ files, readFile, report }: LintContext): Promise<void> {
  for (const file of files) {
    if (isTestFile(file)) continue;
    const source = await readFile(file);
    const masked = maskLiterals(source);
    SET_INTERVAL.lastIndex = 0;
    const matches: number[] = [];
    let match = SET_INTERVAL.exec(masked);
    while (match) {
      matches.push(match.index);
      match = SET_INTERVAL.exec(masked);
    }
    if (matches.length === 0) continue;
    if (CLEAR_INTERVAL.test(masked)) continue;
    const first = matches[0]!;
    const { line, column } = position(masked, first);
    report({
      path: file,
      line,
      column,
      message:
        matches.length === 1
          ? "setInterval() needs a matching clearInterval() in the same file"
          : `${matches.length} setInterval() calls need a matching clearInterval() in the same file`,
    });
  }
}

const rule: LintRule = {
  id: "no-orphan-set-interval",
  title: "setInterval requires clearInterval in the same file",
  severity: "error",
  include: ["src/**/*.ts", "src/**/*.tsx"],
  check,
};

export default rule;
