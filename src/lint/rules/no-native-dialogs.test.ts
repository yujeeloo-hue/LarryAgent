import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLint } from "../engine.js";

const RULES_DIR = join(process.cwd(), "src", "lint", "rules");

async function workspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jellybot-lint-dialogs-"));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

test("native alert/confirm calls are errors, strings and comments are not", async () => {
  const root = await workspace({
    "src/a.ts": [
      'const label = "alert(1) is only text";',
      "// window.confirm('really?') stays a comment",
      "/* alert(1) in a block comment */",
      'window.alert("saved");',
      'const ok = confirm("continue?");',
      "this.alert(\"owned method\")",
      "const helper = (text: string) => text;",
    ].join("\n"),
    "src/b.ts": "export const clean = 1;\n",
  });
  const result = await runLint({ root, rulesDir: RULES_DIR });
  assert.deepEqual(
    result.diagnostics.map((item) => [item.ruleId, item.severity, item.path, item.line, item.column]),
    [
      ["no-native-dialogs", "error", "src/a.ts", 4, 1],
      ["no-native-dialogs", "error", "src/a.ts", 5, 12],
    ],
  );
  assert.equal(result.errorCount, 2);
});

test("test files and relay web are outside this rule's scope", async () => {
  const root = await workspace({
    "src/panel.test.ts": 'test("confirm", () => { confirm("x"); });\n',
    "relay/web/src/main.ts": 'window.alert("still native out there");\n',
  });
  const result = await runLint({ root, rulesDir: RULES_DIR });
  assert.deepEqual(result.diagnostics, []);
});

test("member calls and local declarations are left alone", async () => {
  const root = await workspace({
    "src/panel.ts": [
      "class Panel {",
      "  private async alert(message: string): Promise<void> {",
      "    this.emit(message);",
      "  }",
      "  private emit(_message: string): void { }",
      "}",
      "const dialog = { confirm: (text: string) => text.length > 0 };",
      "void dialog.confirm('x');",
      "void new Panel();",
    ].join("\n"),
    "src/panel.test.ts": 'test("confirm", () => { confirm("x"); });\n',
  });
  const result = await runLint({ root, rulesDir: RULES_DIR });
  assert.deepEqual(result.diagnostics, []);
});

test("the rule reads through comments between the receiver and the call", async () => {
  const root = await workspace({
    "src/c.ts": "window\n  // explain\n  .alert('x');\n",
  });
  const result = await runLint({ root, rulesDir: RULES_DIR });
  assert.deepEqual(result.diagnostics.map((item) => [item.line, item.column]), [[1, 1]]);
});
