import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LintRegistryError, loadRules } from "./registry.js";

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

function ruleSource(id: string, severity = "warn"): string {
  return `export default { id: "${id}", title: "${id} rule", severity: "${severity}", check() {} };`;
}

test("a missing rules directory is a zero-rule set", async () => {
  const dir = await tempDir("jellybot-lint-absent-");
  assert.deepEqual(await loadRules(join(dir, "rules")), []);
});

test("rule files are discovered and sorted without registering them anywhere", async () => {
  const dir = await tempDir("jellybot-lint-rules-");
  await writeFiles(dir, {
    "zeta.mjs": ruleSource("zeta"),
    "alpha.ts": ruleSource("alpha", "error"),
    "notes.md": "not a rule",
    "alpha.test.mjs": ruleSource("should-be-skipped"),
    "_draft.mjs": ruleSource("draft"),
  });
  const rules = await loadRules(dir);
  assert.deepEqual(rules.map((rule) => rule.id), ["alpha", "zeta"]);
  assert.equal(rules[0]!.severity, "error");
});

test("broken or duplicated rules fail loudly instead of being ignored", async () => {
  const dup = await tempDir("jellybot-lint-dup-");
  await writeFiles(dup, { "a.mjs": ruleSource("same"), "b.mjs": ruleSource("same") });
  await assert.rejects(() => loadRules(dup), (error: unknown) =>
    error instanceof LintRegistryError && /duplicate lint rule id "same"/.test(error.message));

  const badId = await tempDir("jellybot-lint-bad-");
  await writeFiles(badId, { "a.mjs": ruleSource("NotKebab") });
  await assert.rejects(() => loadRules(badId), /kebab-case/);

  const noCheck = await tempDir("jellybot-lint-nocheck-");
  await writeFiles(noCheck, { "a.mjs": 'export default { id: "a", title: "a", severity: "warn" };' });
  await assert.rejects(() => loadRules(noCheck), /check\(context\)/);
});
