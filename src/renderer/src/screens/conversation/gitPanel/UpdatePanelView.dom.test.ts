import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window as unknown as { innerWidth?: number };
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  requestAnimationFrame: (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  },
});
if (typeof win.innerWidth !== "number") {
  Object.defineProperty(dom.window, "innerWidth", { value: 1280 });
}

const EventCtor = (dom.window as unknown as { Event: typeof Event }).Event;

type View = typeof import("./UpdatePanelView.js")["UpdatePanelView"];
type Handlers = import("./UpdatePanelView.js")["UpdatePanelHandlers"];

let UpdatePanelView: View;
let formatUpdateBytes: typeof import("./UpdatePanelView.js")["formatUpdateBytes"];
let openSvnUpdatePanel: typeof import("./updateFlow.js")["openSvnUpdatePanel"];

test.before(async () => {
  ({ UpdatePanelView, formatUpdateBytes } = await import("./UpdatePanelView.js"));
  ({ openSvnUpdatePanel } = await import("./updateFlow.js"));
});

function handlers(): Handlers & { log: string[] } {
  const log: string[] = [];
  return {
    log,
    onCancel: () => log.push("cancel"),
    onStop: () => log.push("stop"),
    onResume: () => log.push("resume"),
    onApply: () => log.push("apply"),
  };
}

function text(view: { root: HTMLElement }): string {
  return view.root.textContent ?? "";
}

function button(view: { root: HTMLElement }, label: string): HTMLButtonElement {
  const found = [...view.root.querySelectorAll<HTMLButtonElement>(".git-panel-btn")].find(
    (el) => (el.textContent ?? "").trim() === label,
  );
  assert.ok(found, `button ${label}`);
  return found!;
}

test("running state shows the growing file log and a Stop action", () => {
  const h = handlers();
  const view = new UpdatePanelView({ handlers: h });
  view.showRunning();
  assert.match(text(view), /Waiting for file changes/);
  view.setProgress({ paths: 0, bytes: 0, elapsedMs: 0 });
  view.appendLine({ letter: "U", path: "Content/UI/T_Hero.uasset", bytes: 4_404_019 });
  view.appendLine({ letter: "A", path: "Source/New.cpp", bytes: 1_024 });
  view.setProgress({ paths: 2, bytes: 4_405_043, elapsedMs: 1000 });

  const rows = [...view.root.querySelectorAll(".git-panel-log-row")];
  assert.equal(view.root.querySelector(".git-panel-empty"), null);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.querySelector(".git-panel-log-letter")?.textContent, "U");
  assert.equal(rows[0]?.querySelector(".git-panel-name")?.textContent, "T_Hero.uasset");
  assert.equal(rows[0]?.querySelector(".git-panel-dir")?.textContent, "Content/UI");
  assert.equal(rows[1]?.querySelector(".git-panel-log-letter")?.textContent, "A");
  assert.match(
    view.root.querySelector(".git-panel-section-count")?.textContent ?? "",
    /^2 paths · 4\.2 MB · 4\.2 MB\/s$/,
  );
  assert.equal(view.getMode(), "running");

  const stop = button(view, "Stop");
  assert.equal(stop.disabled, false);
  stop.dispatchEvent(new EventCtor("click"));
  assert.deepEqual(h.log, ["stop"]);
  view.destroy();
});

test("a finished update keeps the file log and drops Stop", () => {
  const h = handlers();
  const view = new UpdatePanelView({ handlers: h });
  view.showRunning();
  view.appendLine({ letter: "U", path: "Content/UI/T_Hero.uasset", bytes: 2048 });
  view.showResult({
    fromRevision: "48213",
    revision: "48290",
    alreadyCurrent: false,
    paths: 39,
    bytes: 12_800_000,
  });

  assert.equal(view.getMode(), "result");
  assert.equal(view.root.querySelector(".git-panel-scope")?.textContent, "r48213 → r48290");
  assert.match(text(view), /Updated to r48290/);
  assert.match(text(view), /39 paths · 12\.2 MB/);
  assert.equal(view.root.querySelector(".is-spinner"), null);
  assert.equal(view.root.querySelectorAll(".git-panel-log-row").length, 1);
  assert.deepEqual(
    [...view.root.querySelectorAll<HTMLButtonElement>(".git-panel-btn")].map((b) => b.textContent),
    ["Close"],
  );
  view.destroy();
});

test("an already-current checkout says so instead of claiming an update", () => {
  const view = new UpdatePanelView({ handlers: handlers() });
  view.showResult({
    fromRevision: "48290",
    revision: "48290",
    alreadyCurrent: true,
    paths: 0,
    bytes: 0,
  });
  assert.match(text(view), /Already at r48290/);
  assert.doesNotMatch(text(view), /Updated to/);
  view.destroy();
});

test("conflicts need one side per file before Apply is enabled", () => {
  const h = handlers();
  const view = new UpdatePanelView({ handlers: h });
  view.showRunning();
  view.appendLine({ letter: "G", path: "Source/NF/NFGameplayAbility.cpp", bytes: 900 });
  view.showConflicts({
    fromRevision: "48213",
    revision: "48290",
    alreadyCurrent: false,
    paths: 39,
    bytes: 12_800_000,
    conflicts: [
      { path: "Source/NF/NFGameplayAbility.cpp", kind: "text" },
      { path: "Content/Maps/NF_Hub.umap", kind: "text" },
    ],
  });

  assert.equal(view.getMode(), "conflicts");
  assert.equal(view.root.querySelector(".git-panel-scope")?.textContent, "r48290 · 2 conflicts");
  assert.match(text(view), /Conflicts/);
  assert.equal(view.root.querySelectorAll(".git-panel-log-row").length, 1, "log rehosted under Updated");

  const apply = button(view, "Apply & close");
  assert.equal(apply.disabled, true);
  assert.equal(view.root.querySelector(".git-panel-status")?.textContent, "2 undecided");
  assert.deepEqual(view.undecided(), [
    "Source/NF/NFGameplayAbility.cpp",
    "Content/Maps/NF_Hub.umap",
  ]);

  const chips = [...view.root.querySelectorAll<HTMLButtonElement>(".git-panel-chip")];
  assert.equal(chips.length, 6);
  chips[1]!.dispatchEvent(new EventCtor("click"));
  assert.equal(chips[1]!.getAttribute("aria-pressed"), "true");
  assert.equal(view.root.querySelector(".git-panel-status")?.textContent, "1 undecided");
  assert.equal(apply.disabled, true);

  chips[5]!.dispatchEvent(new EventCtor("click"));
  assert.equal(view.root.querySelector(".git-panel-status")?.textContent, "All 2 conflicts picked");
  assert.equal(apply.disabled, false);
  assert.deepEqual([...view.choices()], [
    ["Source/NF/NFGameplayAbility.cpp", "theirs"],
    ["Content/Maps/NF_Hub.umap", "both"],
  ]);
  apply.dispatchEvent(new EventCtor("click"));
  assert.deepEqual(h.log, ["apply"]);
  view.destroy();
});

test("a tree conflict offers only the working-copy fallback", () => {
  const view = new UpdatePanelView({ handlers: handlers() });
  view.showRunning();
  view.showConflicts({
    fromRevision: "224664",
    revision: "225061",
    alreadyCurrent: false,
    paths: 12,
    bytes: 1024,
    conflicts: [
      { path: "Content/Script/A.lua", kind: "text" },
      { path: "Content/Script/B.lua", kind: "tree" },
    ],
  });

  assert.equal(
    view.root.querySelector(".git-panel-scope")?.textContent,
    "r225061 · 2 conflicts · 1 tree",
  );
  const chipLabels = [...view.root.querySelectorAll(".git-panel-conflict")].map((row) =>
    [...row.querySelectorAll(".git-panel-chip")].map((chip) => chip.textContent),
  );
  assert.deepEqual(chipLabels, [
    ["Keep mine", "Keep incoming", "Keep both"],
    ["Keep files"],
  ]);

  const chips = [...view.root.querySelectorAll<HTMLButtonElement>(".git-panel-chip")];
  chips[3]!.dispatchEvent(new EventCtor("click"));
  assert.equal(chips[3]!.getAttribute("aria-pressed"), "true");
  assert.deepEqual([...view.choices()], [["Content/Script/B.lua", "working"]]);
  assert.equal(view.root.querySelector(".git-panel-status")?.textContent, "1 undecided");
  view.destroy();
});

test("applied state reports the picked sides and offers Commit", () => {
  let committed = 0;
  const view = new UpdatePanelView({
    handlers: { ...handlers(), onCommit: () => (committed += 1) },
  });
  view.showConflicts({
    fromRevision: "48213",
    revision: "48290",
    alreadyCurrent: false,
    paths: 39,
    bytes: 1,
    conflicts: [{ path: "a.cpp", kind: "text" }],
  });
  view.root.querySelector<HTMLButtonElement>(".git-panel-chip")!.dispatchEvent(new EventCtor("click"));
  view.showApplied({ mine: 1, theirs: 0, both: 0, working: 0 });

  assert.equal(view.getMode(), "applied");
  assert.match(view.root.querySelector(".git-panel-status")?.textContent ?? "", /Resolved 1 conflict — mine ×1/);
  const commit = button(view, "Commit…");
  commit.dispatchEvent(new EventCtor("click"));
  assert.equal(committed, 1);
  assert.equal(
    view.root.querySelector<HTMLButtonElement>(".git-panel-chip")?.disabled,
    true,
    "chips lock once the sides are applied",
  );
  view.destroy();
});

test("stopped state keeps the written paths and offers Resume", () => {
  const h = handlers();
  const view = new UpdatePanelView({ handlers: h });
  view.showRunning();
  view.appendLine({ letter: "U", path: "a.cpp", bytes: 10 });
  view.showStopped({ fromRevision: "48213", paths: 1, bytes: 10 });

  assert.equal(view.getMode(), "stopped");
  assert.match(text(view), /Update stopped/);
  assert.match(text(view), /1 path written/);
  const resume = button(view, "Resume");
  resume.dispatchEvent(new EventCtor("click"));
  assert.deepEqual(h.log, ["resume"]);
  view.destroy();
});

test("errors surface in the status row and leave a Close action", () => {
  const view = new UpdatePanelView({ handlers: handlers() });
  view.showRunning();
  view.appendLine({ letter: "U", path: "a.cpp", bytes: 10 });
  view.showError("svn: E170013: Unable to connect to a repository");
  assert.equal(view.getMode(), "error");
  assert.equal(
    view.root.querySelector(".git-panel-status")?.className.includes("is-error"),
    true,
  );
  assert.match(text(view), /Unable to connect/);
  assert.equal(view.root.querySelectorAll(".git-panel-list").length, 1);
  assert.equal(view.root.querySelectorAll(".git-panel-log-row").length, 1);
  assert.equal(view.root.querySelector(".is-spinner"), null);
  button(view, "Close");
  view.destroy();
});

test("SVN command completion clears busy before the empty result is closed", async () => {
  let listener = (_payload: SvnUpdateEventPayload): void => {};
  let runId = "";
  const busy: boolean[] = [];
  Object.assign(window, {
    jellybot: {
      onSvnUpdateEvent(handler: typeof listener) {
        listener = handler;
        return () => {};
      },
      async startSvnUpdate(_root: string, id: string) {
        runId = id;
        return { ok: true };
      },
    },
  });

  const result = openSvnUpdatePanel({
    root: "E:/repo",
    paths: ["."],
    onBusyChange: value => busy.push(value),
  });
  const root = document.querySelector<HTMLElement>(".git-panel-backdrop")!;
  assert.match(text({ root }), /Waiting for file changes/);
  assert.deepEqual(busy, [true]);
  listener({ runId, event: { type: "checking" } });
  assert.match(text({ root }), /Checking for conflicts/);
  assert.equal(root.querySelector(".is-spinner"), null);
  assert.equal(busy.at(-1), false);

  listener({
    runId,
    event: { type: "done", revision: "123", alreadyCurrent: true, paths: 0, bytes: 0, conflicts: [] },
  });
  assert.match(text({ root }), /Already at r123/);
  assert.equal(root.querySelector(".git-panel-list"), null);
  assert.equal(root.querySelector(".is-spinner"), null);
  assert.equal(busy.at(-1), false);
  button({ root }, "Close").dispatchEvent(new EventCtor("click"));
  assert.deepEqual(await result, { updated: false, resolved: false });
});

test("formatUpdateBytes stays readable across the KB/MB boundary", () => {
  assert.equal(formatUpdateBytes(0), "");
  assert.equal(formatUpdateBytes(900), "0.9 KB");
  assert.equal(formatUpdateBytes(48 * 1024), "48 KB");
  assert.equal(formatUpdateBytes(4_404_019), "4.2 MB");
});
