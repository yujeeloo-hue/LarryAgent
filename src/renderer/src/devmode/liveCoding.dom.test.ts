import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import { installMessageDialogProbe } from "../ui/messageDialogProbe.js";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

type DebugPanelViewT = typeof import("./DebugPanelView.js")["DebugPanelView"];
type LiveCodingControllerT = typeof import("./LiveCodingController.js")["LiveCodingController"];
type SetDevModePreferencesT = typeof import("../state/devModePreferences.js")["setDevModePreferences"];
let DebugPanelView: DebugPanelViewT;
let LiveCodingController: LiveCodingControllerT;
let setDevModePreferences: SetDevModePreferencesT;

test.before(async () => {
  ({ DebugPanelView } = await import("./DebugPanelView.js"));
  ({ LiveCodingController } = await import("./LiveCodingController.js"));
  ({ setDevModePreferences } = await import("../state/devModePreferences.js"));
});

const editor = {
  id: "editor-debuggame",
  kind: "native" as const,
  targetType: "Editor",
  buildReason: null,
  skipBuild: false,
  uproject: "E:/Game/Game.uproject",
  command: "call Build.bat GameEditor Win64 DebugGame -WaitMutex",
  rebuildCommand: "call Rebuild.bat",
  cleanCommand: "call Clean.bat",
};

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("Live Coding stays hidden until the matching editor is running, then compiles with the flag", async () => {
  setDevModePreferences({ liveCoding: true });
  const probes: string[] = [];
  const builds: Array<string | undefined> = [];
  const revealed: string[] = [];
  const dialogs = installMessageDialogProbe(dom.document);
  let running = false;
  let active: Array<{ task: string }> = [];
  let pending: Promise<{ ok: true; runId: string; command: string } | { ok: false; message: string }> | null = null;
  Object.assign(window, {
    jellybot: {
      unrealEditorRunning: async (_root: string, id: string) => {
        probes.push(id);
        return { ok: true as const, running };
      },
      getDevTaskState: async () => ({ ok: true as const, active, last: {}, buildGate: {} }),
      buildUnreal: async (_root: string, _id: string, operation?: string) => {
        builds.push(operation);
        return pending ?? { ok: true as const, runId: "run-1", command: "ubt" };
      },
      onDevTaskExit: () => () => {},
    },
  });
  const view = new DebugPanelView();
  const controller = new LiveCodingController(view, { revealBuild: (root) => { revealed.push(root); } });
  controller.start();
  try {
    controller.setChoice("E:/Game", { ...editor, targetType: "Game" });
    await settle();
    assert.equal(view.liveCodingButton.hidden, true);
    assert.deepEqual(probes, []);

    running = false;
    controller.setChoice("E:/Game", editor);
    await settle();
    if (process.platform !== "win32") {
      assert.equal(view.liveCodingButton.hidden, true);
      assert.deepEqual(builds, []);
      return;
    }
    assert.equal(view.liveCodingButton.hidden, true);

    running = true;
    controller.refresh();
    await settle();
    assert.equal(view.liveCodingButton.hidden, false);
    assert.equal(view.liveCodingButton.disabled, false);

    let release: (value: { ok: false; message: string }) => void = () => {};
    pending = new Promise((resolve) => { release = resolve; });
    view.liveCodingButton.click();
    await settle();
    assert.deepEqual(revealed, ["E:/Game"]);
    assert.deepEqual(builds, ["liveCoding"]);
    assert.equal(view.liveCodingButton.disabled, true);
    view.liveCodingButton.click();
    await settle();
    assert.deepEqual(builds, ["liveCoding"]);

    active = [{ task: "build" }];
    running = false;
    release({ ok: false, message: "Live Coding failed" });
    await settle();
    assert.deepEqual(dialogs.map((dialog) => dialog.message), ["Live Coding failed"]);
    assert.equal(view.liveCodingButton.hidden, false);
    assert.equal(view.liveCodingButton.disabled, true);

    active = [];
    controller.refresh();
    await settle();
    assert.equal(view.liveCodingButton.hidden, true);
  } finally {
    controller.dispose();
    setDevModePreferences({ liveCoding: false });
  }
});

test("Live Coding stays hidden while the Dev Mode preference is off", async () => {
  setDevModePreferences({ liveCoding: false });
  Object.assign(window, {
    jellybot: {
      unrealEditorRunning: async () => ({ ok: true as const, running: true }),
      getDevTaskState: async () => ({ ok: true as const, active: [], last: {}, buildGate: {} }),
      buildUnreal: async () => ({ ok: true as const, runId: "run-1", command: "ubt" }),
      onDevTaskExit: () => () => {},
    },
  });
  const view = new DebugPanelView();
  const controller = new LiveCodingController(view, { revealBuild: () => {} });
  controller.start();
  try {
    controller.setChoice("E:/Game", editor);
    await settle();
    if (process.platform !== "win32") {
      assert.equal(view.liveCodingButton.hidden, true);
      return;
    }
    assert.equal(view.liveCodingButton.hidden, true);

    setDevModePreferences({ liveCoding: true });
    await settle();
    assert.equal(view.liveCodingButton.hidden, false);

    setDevModePreferences({ liveCoding: false });
    await settle();
    assert.equal(view.liveCodingButton.hidden, true);

    setDevModePreferences({ liveCoding: true });
    await settle();
    assert.equal(view.liveCodingButton.hidden, false);
  } finally {
    controller.dispose();
    setDevModePreferences({ liveCoding: false });
  }
});
