import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { ripgrepCandidates } from "../../workspaceScan/ripgrep.js";
import { findLuaScriptRoots, luaScriptRootsFromFiles } from "./scriptRoots.js";

const program = ripgrepCandidates({ devRoots: [process.cwd()] })[0]!;
const available = spawnSync(program, ["--version"], { windowsHide: true }).status === 0;

test("nested Lua folders collapse to their top-most folder; root-level files are ignored", () => {
  const roots = luaScriptRootsFromFiles([
    "Content\\Script\\Hero.lua",
    "Content/Script/Battle/View.lua",
    "Content/Script/IntelliSense/UE/UE_1.lua",
    "./Plugins/UnLua/Content/Script/UnLua.lua",
    "init.lua",
  ]);
  assert.deepEqual(roots, ["Content/Script", "Plugins/UnLua/Content/Script"]);
});

test("only the folders with the most Lua files are kept when over the limit", () => {
  const files = [
    ...Array.from({ length: 5 }, (_, i) => `Big/f${i}.lua`),
    ...Array.from({ length: 3 }, (_, i) => `Mid/f${i}.lua`),
    "Tiny/a.lua",
  ];
  assert.deepEqual(luaScriptRootsFromFiles(files, 2), ["Big", "Mid"]);
});

test("ripgrep discovery skips generated and hidden folders", {
  skip: available ? false : "ripgrep is not available",
}, async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "jb-lua-roots-"));
  try {
    for (const rel of [
      "Content/Script/Hero.lua",
      "Content/Script/Battle/View.lua",
      "Intermediate/Gen/x.lua",
      "Saved/Logs/y.lua",
      ".svn/pristine/z.lua",
      "Content/Maps/Level.umap",
    ]) {
      const file = join(root, rel);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "");
    }
    assert.deepEqual(await findLuaScriptRoots(root, program), [join(root, "Content", "Script")]);
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
