import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

function checkFixture(sources: Record<string, string>, devDependencies: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "larry-check-deps-"));
  try {
    copyFileSync(path.resolve("check-deps.mjs"), path.join(root, "check-deps.mjs"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ devDependencies }));
    for (const folder of ["relay", "relay/web"]) {
      mkdirSync(path.join(root, folder), { recursive: true });
      writeFileSync(path.join(root, folder, "package.json"), "{}");
    }
    for (const [file, source] of Object.entries(sources)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), source);
    }
    return spawnSync(process.execPath, [path.join(root, "check-deps.mjs")], {
      cwd: root, encoding: "utf8", timeout: 10_000,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const imports = 'import { parseHTML } from "linkedom";\nimport * as lucide from "lucide";';
const testDependencies = { linkedom: "*", lucide: "*" };

test("shared icon tests may use declared development dependencies", () => {
  const result = checkFixture({ "src/shared/icons/artwork.test.ts": imports }, testDependencies);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[check-deps\] ok/);
});

test("runtime imports still reject dependencies available only during development", () => {
  const result = checkFixture({ "src/shared/icons/artwork.ts": imports }, testDependencies);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /imported outside the renderer but only in devDependencies/);
  assert.match(result.stderr, /linkedom, lucide/);
});

test("test imports must still be declared in their owning package", () => {
  const result = checkFixture({ "src/shared/icons/artwork.test.ts": imports }, {});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /imported but not declared — linkedom, lucide/);
});
