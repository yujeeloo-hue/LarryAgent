import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
const store = new Map<string, string>();
const localStorageStub = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
};
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
  localStorage: localStorageStub,
});
Object.assign(dom.window, {
  matchMedia: () => ({ matches: true }),
  CSS: { escape: (value: string) => value },
  localStorage: localStorageStub,
});

type SolutionOutlineControllerT =
  typeof import("./SolutionOutlineController.js")["SolutionOutlineController"];
let SolutionOutlineController: SolutionOutlineControllerT;

test.before(async () => {
  ({ SolutionOutlineController } = await import("./SolutionOutlineController.js"));
});

const WORKSPACE = "E:/work/NF";
const SCRIPTS = `${WORKSPACE}/Content/Script`;
const CPP_GUID = "{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}";
const SLN = [
  "Microsoft Visual Studio Solution File, Format Version 12.00",
  `Project("${CPP_GUID}") = "NF", "Intermediate\\ProjectFiles\\NF.vcxproj", "{AAAAAAAA-0000-0000-0000-000000000001}"`,
  "EndProject",
  "Global",
  "EndGlobal",
].join("\r\n");

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(picked: string | null = null) {
  const listed: string[] = [];
  Object.assign(window, {
    jellybot: {
      platform: "win32",
      getUnrealWorkspace: async () => ({ ok: true, workspace: null }),
      getDevTaskConfig: async () => ({ ok: true as const, tasks: [], debugSupported: false, debugKind: null }),
      listDevModeDir: async (path: string) => {
        listed.push(path);
        if (path === WORKSPACE) {
          return { ok: true as const, entries: [{ kind: "file" as const, name: "NF.sln", path: `${WORKSPACE}/NF.sln`, ext: "sln" }] };
        }
        if (path === SCRIPTS) {
          return { ok: true as const, entries: [{ kind: "file" as const, name: "Hero.lua", path: `${SCRIPTS}/Hero.lua`, ext: "lua" }] };
        }
        return { ok: true as const, entries: [] };
      },
      readTextFile: async () => ({ ok: true as const, content: SLN }),
      getDevModeEngineRoot: async () => null,
      readDevModeProjectFile: async () => ({ ok: false as const, message: "not needed" }),
      getVcsStatus: async () => ({ ok: false as const }),
      findLuaScriptRoots: async () => [SCRIPTS],
      pickWorkspaceFolder: async () => picked,
    },
  });
  const controller = new SolutionOutlineController({ onOpenFile: () => undefined });
  await controller.setWorkspace(WORKSPACE);
  await tick();
  return { controller, listed };
}

function labels(controller: InstanceType<SolutionOutlineControllerT>): string[] {
  return [...controller.root.querySelectorAll(".devmode-tree-label")].map((el) => el.textContent ?? "");
}

function row(controller: InstanceType<SolutionOutlineControllerT>, label: string): HTMLElement {
  const hit = [...controller.root.querySelectorAll(".devmode-tree-row")].find(
    (el) => el.querySelector(".devmode-tree-label")?.textContent === label,
  );
  assert.ok(hit, `no outline row labelled ${label}`);
  return hit as HTMLElement;
}

function openMenu(controller: InstanceType<SolutionOutlineControllerT>, label: string): void {
  document.querySelector(".devmode-ctx-menu")?.remove();
  const event = new dom.window.Event("contextmenu", { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 8, clientY: 8 });
  row(controller, label).dispatchEvent(event);
}

function menuItem(prefix: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll(".devmode-ctx-item")].find(
    (el) => el.textContent?.startsWith(prefix),
  ) as HTMLButtonElement | undefined;
}

test("discovered Lua folders are pinned under the solution and browse the disk", async () => {
  store.clear();
  const { controller, listed } = await mount();
  try {
    assert.ok(labels(controller).includes("Content/Script"), labels(controller).join(", "));
    row(controller, "Content/Script").dispatchEvent(new dom.window.Event("click", { bubbles: true }));
    await tick();
    assert.ok(listed.includes(SCRIPTS));
    assert.ok(labels(controller).includes("Hero.lua"));
  } finally {
    document.querySelector(".devmode-ctx-menu")?.remove();
    controller.destroy();
  }
});

test("detach hides a discovered folder across reloads and attach brings it back", async () => {
  store.clear();
  const first = await mount();
  try {
    openMenu(first.controller, "Content/Script");
    assert.equal(menuItem("Delete"), undefined, "an attached root is never offered for deletion");
    const detach = menuItem("Detach Folder");
    assert.ok(detach, "attached roots offer Detach Folder");
    detach.click();
    await tick();
    assert.ok(!labels(first.controller).includes("Content/Script"));
  } finally {
    document.querySelector(".devmode-ctx-menu")?.remove();
    first.controller.destroy();
  }

  const second = await mount(SCRIPTS);
  try {
    assert.ok(!labels(second.controller).includes("Content/Script"), "detach is remembered per workspace");
    openMenu(second.controller, "NF.sln");
    const attach = menuItem("Attach Folder");
    assert.ok(attach, "the solution row offers Attach Folder");
    attach.click();
    await tick();
    assert.ok(labels(second.controller).includes("Content/Script"));
  } finally {
    document.querySelector(".devmode-ctx-menu")?.remove();
    second.controller.destroy();
  }
});
