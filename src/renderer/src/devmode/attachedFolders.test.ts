import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachFolder,
  detachFolder,
  loadAttachedFolderPrefs,
  mergeAttachedFolders,
  saveAttachedFolderPrefs,
} from "./attachedFolders.js";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

test("merged folders are auto minus detached plus attached, without duplicates", () => {
  const auto = ["E:/NF/Content/Script", "E:/NF/Plugins/UnLua/Config/LuaTemplates"];
  const prefs = { attached: ["E:\\NF\\Content\\Script\\", "E:/NF/Tools/Lua"], detached: ["e:/nf/plugins/unlua/config/luatemplates"] };
  assert.deepEqual(mergeAttachedFolders(auto, prefs), ["E:/NF/Content/Script", "E:/NF/Tools/Lua"]);
});

test("attach clears a detach; detaching an auto folder remembers it, a manual one is just removed", () => {
  const auto = ["E:/NF/Content/Script"];
  let prefs = detachFolder({ attached: [], detached: [] }, "E:/NF/Content/Script", auto);
  assert.deepEqual(prefs, { attached: [], detached: ["E:/NF/Content/Script"] });
  prefs = attachFolder(prefs, "E:\\NF\\Content\\Script");
  assert.deepEqual(prefs, { attached: ["E:/NF/Content/Script"], detached: [] });
  prefs = attachFolder(prefs, "E:/NF/Tools");
  prefs = detachFolder(prefs, "E:/NF/Tools", auto);
  assert.deepEqual(prefs, { attached: ["E:/NF/Content/Script"], detached: [] });
});

test("prefs persist per workspace and empty prefs are removed", () => {
  const storage = memoryStorage();
  saveAttachedFolderPrefs("E:\\NF", { attached: ["E:/NF/Tools"], detached: [] }, storage);
  assert.deepEqual(loadAttachedFolderPrefs("e:/nf/", storage), { attached: ["E:/NF/Tools"], detached: [] });
  assert.deepEqual(loadAttachedFolderPrefs("E:/Other", storage), { attached: [], detached: [] });
  saveAttachedFolderPrefs("E:/NF", { attached: [], detached: [] }, storage);
  assert.equal(storage.map.size, 0);
  storage.setItem("devmode.attachedFolders:e:/nf", "not json");
  assert.deepEqual(loadAttachedFolderPrefs("E:/NF", storage), { attached: [], detached: [] });
});
