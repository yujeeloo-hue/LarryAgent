import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { busyProjectFor, mutationPaths } from "./busyGuard.js";

const app = resolve("/work/app");
const lib = resolve("/work/app/packages/lib");
const site = resolve("/work/site");
const projects = [{ id: "app", name: "App", path: app }, { id: "lib", name: "Lib", path: lib }, { id: "site", name: "Site", path: site }];

test("mutationPaths covers write_file, convert_to_pdf and V4A patch bodies", () => {
  assert.deepEqual(mutationPaths("write_file", { path: "notes.md" }, "/home/coco"), [resolve("/home/coco/notes.md")]);
  assert.deepEqual(mutationPaths("convert_to_pdf", { path: "/a.md", output: "/work/site/a.pdf" }, "/h"), [resolve("/work/site/a.pdf")]);
  assert.deepEqual(mutationPaths("patch", { mode: "patch", patch: "*** Begin Patch\n*** Update File: /work/app/a.ts\n*** Add File: /work/site/b.ts\n*** End Patch" }, "/h"), [resolve("/work/app/a.ts"), resolve("/work/site/b.ts")]);
  assert.deepEqual(mutationPaths("read_file", { path: "/work/app/a.ts" }, "/h"), []);
});

test("busy only when a touched project has an active turn; nested roots win", () => {
  const active = new Set(["lib"]);
  const busy = (id: string): boolean => active.has(id);
  assert.equal(busyProjectFor("write_file", { path: resolve(lib, "x.ts") }, "/h", projects, busy)?.id, "lib");
  assert.equal(busyProjectFor("write_file", { path: resolve(app, "src/x.ts") }, "/h", projects, busy), undefined);
  assert.equal(busyProjectFor("write_file", { path: "/home/coco/COCO_MEMORY.md" }, "/h", projects, busy), undefined);
  assert.equal(busyProjectFor("read_file", { path: resolve(lib, "x.ts") }, "/h", projects, busy), undefined);
});

test("shell commands naming a busy project root are refused", () => {
  const busy = (id: string): boolean => id === "site";
  assert.equal(busyProjectFor("run_shell", { command: `cd ${site} && npm test` }, "/h", projects, busy)?.id, "site");
  assert.equal(busyProjectFor("run_shell", { command: `ls ${app}` }, "/h", projects, busy), undefined);
});

test("updating another project's PROJECT.md is refused while that project is busy", () => {
  const busy = (id: string): boolean => id === "site";
  assert.equal(busyProjectFor("update_project_memory", { content: "x", workspace_id: "site" }, "/h", projects, busy)?.id, "site");
  assert.equal(busyProjectFor("update_project_memory", { content: "x", workspace_id: "app" }, "/h", projects, busy), undefined);
});
