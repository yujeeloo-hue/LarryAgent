import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { findLuaServer, luaServerCandidates, resolveLuaRoot } from "./locate.js";

test("a packaged app only ever uses the emmylua_ls shipped in its resources", () => {
  assert.deepEqual(
    luaServerCandidates({ packaged: true, resourcesPath: "/R", devRoots: ["/dev"] }, "darwin"),
    [join("/R", "emmylua", "emmylua_ls")],
  );
  assert.deepEqual(
    luaServerCandidates({ packaged: true, resourcesPath: "C:/App/resources" }, "win32"),
    [join("C:/App/resources", "emmylua", "emmylua_ls.exe")],
  );
  assert.deepEqual(luaServerCandidates({ packaged: true }, "win32"), []);
});

test("development uses the repository's extracted emmylua_ls for this platform", () => {
  assert.deepEqual(
    luaServerCandidates({ packaged: false, resourcesPath: "/electron", devRoots: ["/repo", "/repo"], arch: "x64" }, "win32"),
    [join("/repo", "resources", "emmylua", "win32-x64", "emmylua_ls.exe")],
  );
});

test("findLuaServer returns the bundled binary or null, never a PATH fallback", () => {
  const bundled = join("/R", "emmylua", "emmylua_ls");
  assert.equal(findLuaServer({ packaged: true, resourcesPath: "/R" }, (p) => p === bundled, "linux"), bundled);
  assert.equal(findLuaServer({ packaged: true, resourcesPath: "/R" }, () => false, "linux"), null);
});

test("the nearest config file directory inside the workspace becomes the root", () => {
  const ws = resolve("/ws");
  const scripts = join(ws, "Content", "Script");
  const file = join(scripts, "Battle", "View.lua");
  const exists = (p: string) => p === join(scripts, ".emmyrc.json");
  assert.equal(resolveLuaRoot(file, ws, exists), scripts);
  const luarc = (p: string) => p === join(scripts, "Battle", ".luarc.json");
  assert.equal(resolveLuaRoot(file, ws, luarc), join(scripts, "Battle"));
});

test("without a config file, or outside the workspace, the workspace root is used", () => {
  const ws = resolve("/ws");
  assert.equal(resolveLuaRoot(join(ws, "Content", "a.lua"), ws, () => false), ws);
  const outside = resolve("/other/x.lua");
  assert.equal(resolveLuaRoot(outside, ws, (p) => p === resolve("/other/.emmyrc.json")), ws);
  assert.equal(resolveLuaRoot(join(ws, "a.lua"), ws, (p) => p === resolve("/.emmyrc.json")), ws);
});
