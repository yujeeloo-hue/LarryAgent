/**
 * workspaceInit — detection + skip-aware writes (pure parts; the runner's
 * shell calls are exercised only through integration, not here).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  detectInitPlan,
  isTemplateInitRequest,
  lastOutputLine,
  writeTemplateFiles,
} from "./workspaceInit.js";

/** In-memory fs double for detectInitPlan / writeTemplateFiles. */
function fakeFs(existing: readonly string[] = []) {
  const set = new Set(existing);
  const written = new Map<string, string>();
  const dirs: string[] = [];
  return {
    exists: (p: string) => set.has(p) || written.has(p),
    mkdir: async (p: string) => {
      dirs.push(p);
    },
    writeFile: async (p: string, c: string) => {
      written.set(p, c);
    },
    written,
    dirs,
  };
}

const PROJECT_ROOT = join(tmpdir(), "jb-workspace-init-unit");

describe("detectInitPlan", () => {
  const base = { path: PROJECT_ROOT };

  it("fresh folder → git + install will run", () => {
    assert.deepEqual(detectInitPlan({ ...base, templateId: "web-node" }, fakeFs()), {
      git: "will-run",
      install: "will-run",
    });
  });

  it("existing .git / node_modules → skip", () => {
    const fs = fakeFs([join(PROJECT_ROOT, ".git"), join(PROJECT_ROOT, "node_modules")]);
    assert.deepEqual(
      detectInitPlan({ ...base, templateId: "electron" }, fs),
      { git: "skip-exists", install: "skip-exists" },
    );
  });

  it("unreal (and blank) → n/a, folder state irrelevant", () => {
    const fs = fakeFs();
    assert.deepEqual(detectInitPlan({ ...base, templateId: "unreal" }, fs), {
      git: "n-a",
      install: "n-a",
    });
  });
});

describe("writeTemplateFiles", () => {
  it("writes new files and creates parent dirs", async () => {
    const fs = fakeFs();
    const res = await writeTemplateFiles(
      PROJECT_ROOT,
      [
        { path: "package.json", content: "{}" },
        { path: "src/routes.js", content: "export {};" },
      ],
      fs,
    );
    assert.deepEqual(res, { written: ["package.json", "src/routes.js"], skipped: [] });
    assert.equal(fs.written.get(join(PROJECT_ROOT, "src", "routes.js")), "export {};");
    assert.ok(fs.dirs.includes(join(PROJECT_ROOT, "src")));
  });

  it("never overwrites existing files — skips and reports", async () => {
    const fs = fakeFs([join(PROJECT_ROOT, "package.json")]);
    const res = await writeTemplateFiles(
      PROJECT_ROOT,
      [
        { path: "package.json", content: "NEW" },
        { path: "README.md", content: "hi" },
      ],
      fs,
    );
    assert.deepEqual(res.written, ["README.md"]);
    assert.deepEqual(res.skipped, ["package.json"]);
    assert.ok(!fs.written.has(join(PROJECT_ROOT, "package.json")));
  });

  it("skip check sees files written earlier in the same run", async () => {
    const fs = fakeFs();
    const res = await writeTemplateFiles(
      PROJECT_ROOT,
      [
        { path: "a.txt", content: "1" },
        { path: "a.txt", content: "2" },
      ],
      fs,
    );
    assert.deepEqual(res.written, ["a.txt"]);
    assert.deepEqual(res.skipped, ["a.txt"]);
    assert.equal(fs.written.get(join(PROJECT_ROOT, "a.txt")), "1");
  });
});

describe("lastOutputLine", () => {
  it("returns the last meaningful npm output line", () => {
    assert.equal(
      lastOutputLine("added 212 packages, and audited 213 packages in 6s\n\n15 packages are looking for funding\n"),
      "15 packages are looking for funding",
    );
  });

  it("handles \\r progress lines and blank input", () => {
    assert.equal(lastOutputLine("reify:express: timing reifyNode:node_modules/express Completed in 12ms\r\nadded 1 package in 2s\r\n"), "added 1 package in 2s");
    assert.equal(lastOutputLine("   \n\n"), null);
    assert.equal(lastOutputLine(""), null);
  });
});

describe("isTemplateInitRequest", () => {
  it("accepts a well-formed request", () => {
    assert.ok(
      isTemplateInitRequest({ templateId: "web-node", name: "App", path: "/tmp/a" }),
    );
  });

  it("rejects malformed requests", () => {
    assert.ok(!isTemplateInitRequest(null));
    assert.ok(!isTemplateInitRequest({ templateId: "mac-app", name: "A", path: "/p" }));
    assert.ok(!isTemplateInitRequest({ templateId: "unreal", name: "  ", path: "/p" }));
    assert.ok(!isTemplateInitRequest({ templateId: "unreal", name: "A", path: "" }));
  });
});
