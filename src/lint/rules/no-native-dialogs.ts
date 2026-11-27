import type { LintContext, LintRule } from "../types.js";
import { isTestFile, maskLiterals, position } from "./_mask.js";

const CALL = /(?<![\w$.])(?:window\s*\.\s*|globalThis\s*\.\s*|self\s*\.\s*)?(alert|confirm)\s*\(/g;
const DECLARATION_PREFIX = /^\s*(?:(?:public|private|protected|static|async|readonly|abstract|override|declare|function)\b\s*)+\*?\s*$/;

async function check({ files, readFile, report }: LintContext): Promise<void> {
  for (const file of files) {
    if (isTestFile(file)) continue;
    const source = await readFile(file);
    const masked = maskLiterals(source);
    CALL.lastIndex = 0;
    let match = CALL.exec(masked);
    while (match) {
      const name = match[1] ?? "alert";
      const prefix = masked.slice(masked.lastIndexOf("\n", match.index) + 1, match.index);
      if (!DECLARATION_PREFIX.test(prefix)) {
        const { line, column } = position(masked, match.index);
        report({
          path: file,
          line,
          column,
          message: `native ${name}() is not allowed — use the in-app dialog or notification path`,
        });
      }
      match = CALL.exec(masked);
    }
  }
}

const rule: LintRule = {
  id: "no-native-dialogs",
  title: "no native alert/confirm dialogs",
  severity: "error",
  include: ["src/**/*.ts", "src/**/*.tsx"],
  check,
};

export default rule;
