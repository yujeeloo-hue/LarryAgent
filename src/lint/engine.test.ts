import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runLint } from "./engine.js";
import { exitCodeForResult } from "./report.js";

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, body);
  }
}

const TRAILING_SPACE_RULE = `export default {
  id: "trailing-space",
  title: "no trailing whitespace",
  severity: "warn",
  include: ["**/*.ts"],
  async check({ files, readFile, report }) {
    for (const file of files) {
      const text = await readFile(file);
      text.split("\\n").forEach((line, index) => {
        if (line !== line.trimEnd()) {
          report({ path: file, line: index + 1, column: line.trimEnd().length + 1, message: "trailing whitespace" });
        }
      });
    }
  },
};`;

const ABSOLUTE_RULE = `export default {
  id: "absolute-path",
  title: "reports absolute paths",
  severity: "error",
  include: ["src/**/*.ts"],
  check({ root, files, report }) {
    for (const file of files) {
      report({ path: root + "/" + file, line: 1, column: 1, message: "absolute finding" });
      report({ path: root + "/" + file, line: 1, column: 1, message: "absolute finding" });
    }
  },
};`;

async function fixture(): Promise<{ root: string; rulesDir: string }> {
  const root = await tempDir("jellybot-lint-ws-");
  await writeFiles(root, {
    "src/a.ts": "const a = 1; \nconst b = 2;\n",
    "src/b.ts": "const c = 3;\n",
    "docs/readme.md": "trailing space \n",
    ".env": "SECRET=1 \n",
  });
  const rulesDir = await tempDir("jellybot-lint-rules-");
  await writeFiles(rulesDir, {
    "trailing-space.mjs": TRAILING_SPACE_RULE,
    "absolute-path.mjs": ABSOLUTE_RULE,
  });
  return { root, rulesDir };
}

test("a zero-rule framework reports nothing and passes", async () => {
  const root = await tempDir("jellybot-lint-empty-");
  await writeFiles(root, { "src/a.ts": "const a = 1;\n" });
  const result = await runLint({ root, rulesDir: join(root, "src/lint/rules") });
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.ruleCount, 0);
  assert.equal(result.fileCount, 1);
  assert.equal(result.scoped, false);
  assert.equal(exitCodeForResult(result), 0);
});

test("rules run over include-filtered files and findings keep their own severity", async () => {
  const { root, rulesDir } = await fixture();
  const result = await runLint({ root, rulesDir });
  assert.equal(result.ruleCount, 2);
  assert.equal(result.fileCount, 3);
  assert.deepEqual(
    result.diagnostics.map((item) => [item.ruleId, item.path, item.line, item.column, item.severity]),
    [
      ["absolute-path", "src/a.ts", 1, 1, "error"],
      ["trailing-space", "src/a.ts", 1, 13, "warn"],
      ["absolute-path", "src/b.ts", 1, 1, "error"],
    ],
  );
  assert.equal(result.errorCount, 2);
  assert.equal(result.warningCount, 1);
  assert.equal(exitCodeForResult(result), 1);
});

test("targets pick single files, directory trees and globs, and report misses", async () => {
  const { root, rulesDir } = await fixture();
  const single = await runLint({ root, rulesDir, targets: [join(root, "src/a.ts")] });
  assert.equal(single.scoped, true);
  assert.equal(single.fileCount, 1);
  assert.deepEqual(single.diagnostics.map((item) => item.path), ["src/a.ts", "src/a.ts"]);

  const directory = await runLint({ root, rulesDir, targets: ["src"] });
  assert.equal(directory.fileCount, 2);

  const glob = await runLint({ root, rulesDir, targets: ["src/*.ts"] });
  assert.equal(glob.fileCount, 2);

  const miss = await runLint({ root, rulesDir, targets: ["src", "nope.ts"] });
  assert.deepEqual(miss.missingTargets, ["nope.ts"]);
  assert.equal(exitCodeForResult(miss), 2);
});

test("an explicitly named file is linted even when it is outside the scan scope", async () => {
  const root = await tempDir("jellybot-lint-explicit-");
  await writeFiles(root, { "node_modules/pkg/index.ts": "const a = 1; \n", "src/a.ts": "const b = 1;\n" });
  const rulesDir = await tempDir("jellybot-lint-rules-");
  await writeFiles(rulesDir, { "trailing-space.mjs": TRAILING_SPACE_RULE });
  const result = await runLint({ root, rulesDir, targets: ["node_modules/pkg/index.ts"] });
  assert.equal(result.fileCount, 1);
  assert.deepEqual(result.diagnostics.map((item) => item.path), ["node_modules/pkg/index.ts"]);
});

test("a throwing rule names itself instead of hiding the failure", async () => {
  const root = await tempDir("jellybot-lint-throw-");
  await writeFiles(root, { "src/a.ts": "const a = 1;\n" });
  const rulesDir = await tempDir("jellybot-lint-rules-");
  await writeFiles(rulesDir, {
    "boom.mjs": 'export default { id: "boom", title: "boom", severity: "warn", check() { throw new Error("kaboom"); } };',
  });
  await assert.rejects(() => runLint({ root, rulesDir }), /rule "boom" failed: kaboom/);
});
