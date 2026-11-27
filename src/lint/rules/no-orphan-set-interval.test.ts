import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLint } from "../engine.js";

const RULES_DIR = join(process.cwd(), "src", "lint", "rules");

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jellybot-lint-interval-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

test("setInterval without a matching clearInterval in the same file is an error", async () => {
  const root = await workspace({
    "src/leak.ts": [
      "export function start(tick: () => void): void {",
      "  const id = setInterval(tick, 100);",
      "  void id;",
      "}",
    ].join("\n"),
    "src/ok.ts": [
      "export function start(tick: () => void): () => void {",
      "  const id = setInterval(tick, 100);",
      "  return () => clearInterval(id);",
      "}",
    ].join("\n"),
    "src/window.ts": "export const id = window.setInterval(() => {}, 10);\nexport const stop = () => window.clearInterval(id);\n",
    "src/member.ts": "export const make = (timer: { setInterval: (f: () => void) => void }) => timer.setInterval(() => {});\n",
    "src/text.ts": [
      'export const note = "setInterval(fn, 10)";',
      "// clearInterval in a comment does not count",
      "/* neither does setInterval() here */",
    ].join("\n"),
  });
  const result = await runLint({ root, rulesDir: RULES_DIR });
  assert.deepEqual(
    result.diagnostics.map((item) => [item.ruleId, item.severity, item.path, item.line, item.column]),
    [["no-orphan-set-interval", "error", "src/leak.ts", 2, 14]],
  );
});

test("a clearInterval that only appears in a comment still leaves the interval orphaned", async () => {
  const root = await workspace({
    "src/commented.ts": [
      "const id = setInterval(() => {}, 10);",
      "// TODO: clearInterval(id) on unmount",
    ].join("\n"),
  });
  const result = await runLint({ root, rulesDir: RULES_DIR });
  assert.deepEqual(result.diagnostics.map((item) => [item.path, item.line, item.column]), [["src/commented.ts", 1, 12]]);
});

test("multiple orphan intervals report once per file, and test files are skipped", async () => {
  const root = await workspace({
    "src/two.ts": "setInterval(() => {}, 1);\nsetInterval(() => {}, 2);\n",
    "src/timer.test.ts": "setInterval(() => {}, 1);\n",
  });
  const result = await runLint({ root, rulesDir: RULES_DIR });
  assert.deepEqual(result.diagnostics.map((item) => item.path), ["src/two.ts"]);
  assert.match(result.diagnostics[0]!.message, /^2 setInterval\(\) calls/);
});
