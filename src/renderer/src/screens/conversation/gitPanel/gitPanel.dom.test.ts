import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
const win = dom.window as unknown as {
  jellybot?: unknown;
  innerWidth?: number;
  setTimeout?: unknown;
};
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
if (typeof win.setTimeout !== "function") {
  Object.assign(dom.window, {
    setTimeout: (cb: () => void, ms?: number) => setTimeout(cb, ms),
    clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
  });
}
if (typeof win.innerWidth !== "number") {
  Object.defineProperty(dom.window, "innerWidth", { value: 1280 });
}

const EventCtor = (dom.window as unknown as { Event: typeof Event }).Event;

type CommitView = typeof import("./CommitPanelView.js")["CommitPanelView"];
type CommitGroup = import("./CommitPanelView.js")["CommitPanelGroup"];
type PullView = typeof import("./PullPanelView.js")["PullPanelView"];

let CommitPanelView: CommitView;
let PullPanelView: PullView;
let openCommitPanel: typeof import("./commitFlow.js")["openCommitPanel"];
let openPullPanel: typeof import("./pullFlow.js")["openPullPanel"];

test.before(async () => {
  ({ CommitPanelView } = await import("./CommitPanelView.js"));
  ({ PullPanelView } = await import("./PullPanelView.js"));
  ({ openCommitPanel } = await import("./commitFlow.js"));
  ({ openPullPanel } = await import("./pullFlow.js"));
});

function commitGroups(): CommitGroup[] {
  return [
    {
      id: "workspace",
      kind: "Working copy",
      branch: "main",
      files: [
        {
          id: "src/a.ts",
          path: "src/deep/a.ts",
          status: "modified",
          insertions: 12,
          deletions: 3,
          binary: false,
          selectable: true,
          checked: true,
        },
        {
          id: "logo.png",
          path: "assets/logo.png",
          status: "added",
          insertions: 0,
          deletions: 0,
          binary: true,
          selectable: true,
          checked: false,
        },
      ],
    },
    {
      id: "repo:dev",
      kind: "Collaborative",
      branch: "feature/x",
      files: [
        {
          id: "repo:dev",
          path: "CommitDialogView.ts",
          status: "modified",
          insertions: 0,
          deletions: 0,
          binary: false,
          selectable: true,
          checked: true,
        },
      ],
    },
  ];
}

function committedText(view: { root: HTMLElement }): string {
  return view.root.textContent ?? "";
}

function contextmenuEvent(x = 120, y = 80): Event {
  const event = new EventCtor("contextmenu", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientX", { value: x });
  Object.defineProperty(event, "clientY", { value: y });
  return event;
}

function keyEvent(key: string, target: EventTarget): Event {
  const event = new EventCtor("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "key", { value: key });
  target.dispatchEvent(event);
  return event;
}

test("commit panel renders branch groups with dir, stats and status letters", () => {
  const view = new CommitPanelView({
    title: "Commit · jelly · GIT",
    groups: commitGroups(),
    handlers: { onCancel: () => {}, onGenerate: () => {}, onCommit: () => {} },
  });
  view.root.querySelectorAll<HTMLElement>(".git-panel-check").forEach(box => {
    if (box.checked) return;
  });
  const rows = [...view.root.querySelectorAll(".git-panel-file")];
  assert.equal(rows.length, 3);
  const branches = [...view.root.querySelectorAll(".git-panel-group-branch")].map(el => el.textContent);
  assert.deepEqual(branches, ["main", "feature/x"]);

  const first = rows[0] as HTMLElement;
  assert.equal(first.querySelector(".git-panel-name")?.textContent, "a.ts");
  assert.equal(first.querySelector(".git-panel-dir")?.textContent, "src/deep");
  assert.equal(first.querySelector(".git-panel-stats")?.textContent, "+12-3");
  assert.equal(first.querySelector(".git-panel-st")?.textContent, "M");
  assert.equal(
    (rows[1] as HTMLElement).querySelector(".git-panel-st")?.textContent,
    "A",
    "added file keeps its A badge",
  );
  assert.equal(view.root.querySelector(".git-panel-lang")?.getAttribute("data-lang"), "typescript");
  view.destroy();
});

test("commit panel scope tracks the checked files and their branches", () => {
  const view = new CommitPanelView({
    title: "Commit",
    groups: commitGroups(),
    handlers: { onCancel: () => {}, onGenerate: () => {}, onCommit: () => {} },
  });
  assert.equal(view.root.querySelector(".git-panel-scope")?.textContent, "2 files · 2 branches");
  const checks = [...view.root.querySelectorAll<HTMLInputElement>(".git-panel-check")];
  assert.equal(checks.length, 3);
  checks[0]!.checked = false;
  checks[0]!.dispatchEvent(new EventCtor("change"));
  assert.equal(view.root.querySelector(".git-panel-scope")?.textContent, "1 file · 1 branch");
  assert.deepEqual(view.selectedIds(), ["repo:dev"]);
  view.destroy();
});

test("commit panel select all tracks file selection across collapsed groups", () => {
  const groups = commitGroups();
  const view = new CommitPanelView({
    title: "Git Commit",
    groups,
    handlers: { onCancel: () => {}, onGenerate: () => {}, onCommit: () => {} },
  });
  const master = view.root.querySelector<HTMLInputElement>(".git-panel-select-all input")!;
  const count = view.root.querySelector(".git-panel-selection-count")!;
  const commit = action(view.root, "Commit");
  view.setMessage("Update files");
  view.root.querySelectorAll<HTMLButtonElement>(".git-panel-group-head")[1]!.click();

  assert.equal(master.indeterminate, true);
  assert.equal(count.textContent, "2 / 3 selected");
  master.checked = true;
  master.dispatchEvent(new EventCtor("change"));
  assert.equal(master.indeterminate, false);
  assert.equal(master.checked, true);
  assert.deepEqual(view.selectedIds(), ["src/a.ts", "logo.png", "repo:dev"]);
  assert.equal(count.textContent, "3 / 3 selected");

  view.setBusy("commit");
  assert.equal(master.disabled, true);
  view.setBusy(null);
  assert.equal(master.disabled, false);
  master.checked = false;
  master.dispatchEvent(new EventCtor("change"));
  assert.equal(count.textContent, "0 / 3 selected");
  assert.equal(commit.disabled, true);
  assert.deepEqual(view.selectedIds(), []);
  assert.ok(groups.every(group => group.files.every(file => !file.checked)));

  const file = view.root.querySelector<HTMLInputElement>(".git-panel-check")!;
  file.checked = true;
  file.dispatchEvent(new EventCtor("change"));
  assert.equal(master.checked, false);
  assert.equal(master.indeterminate, true);
  assert.equal(count.textContent, "1 / 3 selected");
  assert.equal(commit.disabled, false);
  view.destroy();
});

test("commit panel disables Commit until a message exists and a file is picked", () => {
  let committed = "";
  const view = new CommitPanelView({
    title: "Commit",
    groups: commitGroups(),
    handlers: {
      onCancel: () => {},
      onGenerate: () => {},
      onCommit: message => {
        committed = message;
      },
    },
  });
  const commitBtn = [...view.root.querySelectorAll<HTMLButtonElement>(".git-panel-btn")].find(
    button => button.textContent === "Commit",
  )!;
  assert.equal(commitBtn.disabled, true, "no message yet");
  view.setMessage("Summarise the change");
  assert.equal(commitBtn.disabled, false);
  commitBtn.dispatchEvent(new EventCtor("click"));
  assert.equal(committed, "Summarise the change");
  view.destroy();
});

test("commit panel AI Generate shows a busy label and keeps the button locked", () => {
  let generated = 0;
  const view = new CommitPanelView({
    title: "Commit",
    groups: commitGroups(),
    handlers: {
      onCancel: () => {},
      onGenerate: () => {
        generated += 1;
      },
      onCommit: () => {},
    },
  });
  const generate = [...view.root.querySelectorAll<HTMLButtonElement>(".git-panel-btn")].find(button =>
    (button.textContent ?? "").includes("AI Generate"),
  )!;
  generate.dispatchEvent(new EventCtor("click"));
  assert.equal(generated, 1);
  view.setBusy("generate");
  assert.match(committedText(view), /Generating…/);
  assert.equal(generate.disabled, true);
  view.setBusy(null);
  assert.match(committedText(view), /AI Generate/);
  view.destroy();
});

test("commit panel renders an empty state when the working tree is clean", () => {
  const view = new CommitPanelView({
    title: "Commit",
    groups: [],
    handlers: { onCancel: () => {}, onGenerate: () => {}, onCommit: () => {} },
  });
  assert.match(view.root.querySelector(".git-panel-empty")?.textContent ?? "", /Nothing to commit/);
  view.destroy();
});

test("commit panel double-click hands the file (and its diff source) to the handler", () => {
  const groups = commitGroups();
  groups[0]!.files[0]!.diff = { root: "E:/repo", path: "src/deep/a.ts" };
  const opened: string[] = [];
  const view = new CommitPanelView({
    title: "Commit",
    groups,
    handlers: {
      onCancel: () => {},
      onGenerate: () => {},
      onCommit: () => {},
      onOpenDiff: file => opened.push(file.id),
    },
  });
  const row = view.root.querySelector<HTMLElement>(".git-panel-file")!;
  assert.equal(row.classList.contains("is-diffable"), true);
  assert.match(row.title, /Right-click or double-click to view the diff/);
  row.dispatchEvent(new EventCtor("dblclick"));
  assert.deepEqual(opened, ["src/a.ts"]);
  view.destroy();
});

test("commit panel rows are not diffable when no handler is wired", () => {
  const view = new CommitPanelView({
    title: "Commit",
    groups: commitGroups(),
    handlers: { onCancel: () => {}, onGenerate: () => {}, onCommit: () => {} },
  });
  const row = view.root.querySelector<HTMLElement>(".git-panel-file")!;
  assert.equal(row.classList.contains("is-diffable"), false);
  assert.equal(row.title, "src/deep/a.ts");
  view.destroy();
});

test("only the checkbox changes the selection — a row click never toggles it", () => {
  const view = new CommitPanelView({
    title: "Commit",
    groups: commitGroups(),
    handlers: {
      onCancel: () => {},
      onGenerate: () => {},
      onCommit: () => {},
      onOpenDiff: () => {},
    },
  });
  const row = view.root.querySelector<HTMLElement>(".git-panel-file")!;
  // A <label> would forward every row click to its checkbox.
  assert.equal(row.tagName, "DIV");
  assert.equal(view.checkedCount(), 2);

  row.querySelector<HTMLElement>(".git-panel-name")!.dispatchEvent(new EventCtor("click"));
  row.dispatchEvent(new EventCtor("click"));
  assert.equal(view.checkedCount(), 2, "row clicks leave the selection alone");

  const checkbox = row.querySelector<HTMLInputElement>(".git-panel-check")!;
  checkbox.checked = false;
  checkbox.dispatchEvent(new EventCtor("change"));
  assert.equal(view.checkedCount(), 1, "the checkbox drives the selection");
  view.destroy();
});

test("right-click opens a row menu that hands the file to the diff handler", () => {
  const groups = commitGroups();
  groups[0]!.files[0]!.diff = { root: "E:/repo", path: "src/deep/a.ts" };
  const opened: string[] = [];
  const view = new CommitPanelView({
    title: "Commit",
    groups,
    handlers: {
      onCancel: () => {},
      onGenerate: () => {},
      onCommit: () => {},
      onOpenDiff: file => opened.push(file.id),
    },
  });
  const row = view.root.querySelector<HTMLElement>(".git-panel-file")!;
  assert.match(row.title, /Right-click or double-click to view the diff/);
  row.dispatchEvent(contextmenuEvent());

  const menu = document.body.querySelector<HTMLElement>(".git-panel-ctx-menu");
  assert.ok(menu, "right-click opens the row menu");
  assert.equal(menu.getAttribute("role"), "menu");
  const items = [...menu.querySelectorAll<HTMLButtonElement>(".git-panel-ctx-item")];
  assert.deepEqual(items.map(item => item.textContent), ["View Diff", "Copy Path"]);
  assert.equal(items[0]!.disabled, false);

  items[0]!.dispatchEvent(new EventCtor("click"));
  assert.deepEqual(opened, ["src/a.ts"]);
  assert.equal(document.body.querySelector(".git-panel-ctx-menu"), null, "menu closes after the pick");
  view.destroy();
});

test("right-click disables View Diff when the row carries no diff source", () => {
  const opened: string[] = [];
  const view = new CommitPanelView({
    title: "Commit",
    groups: commitGroups(),
    handlers: {
      onCancel: () => {},
      onGenerate: () => {},
      onCommit: () => {},
      onOpenDiff: file => opened.push(file.id),
    },
  });
  const row = view.root.querySelector<HTMLElement>(".git-panel-file")!;
  row.dispatchEvent(contextmenuEvent());
  const diffItem = document.body.querySelector<HTMLButtonElement>(".git-panel-ctx-item")!;
  assert.equal(diffItem.disabled, true);
  diffItem.dispatchEvent(new EventCtor("click"));
  assert.deepEqual(opened, []);
  view.destroy();
});

test("right-click stays inert when no diff handler is wired", () => {
  const view = new CommitPanelView({
    title: "Commit",
    groups: commitGroups(),
    handlers: { onCancel: () => {}, onGenerate: () => {}, onCommit: () => {} },
  });
  view.root.querySelector<HTMLElement>(".git-panel-file")!.dispatchEvent(contextmenuEvent());
  assert.equal(document.body.querySelector(".git-panel-ctx-menu"), null);
  view.destroy();
});

test("Escape closes the row menu without closing the panel", () => {
  let cancelled = 0;
  const view = new CommitPanelView({
    title: "Commit",
    groups: commitGroups(),
    handlers: {
      onCancel: () => { cancelled += 1; },
      onGenerate: () => {},
      onCommit: () => {},
      onOpenDiff: () => {},
    },
  });
  view.root.querySelector<HTMLElement>(".git-panel-file")!.dispatchEvent(contextmenuEvent());
  assert.ok(document.body.querySelector(".git-panel-ctx-menu"));

  const textarea = view.root.querySelector<HTMLTextAreaElement>(".git-panel-message")!;
  keyEvent("Escape", textarea);
  assert.equal(document.body.querySelector(".git-panel-ctx-menu"), null, "menu dismissed first");
  assert.equal(cancelled, 0, "first Escape only dismisses the menu");

  keyEvent("Escape", textarea);
  assert.equal(cancelled, 1, "second Escape closes the panel");
  view.destroy();
});

test("replacing the file list dismisses an open row menu", () => {
  const view = new CommitPanelView({
    title: "Commit",
    groups: commitGroups(),
    handlers: {
      onCancel: () => {},
      onGenerate: () => {},
      onCommit: () => {},
      onOpenDiff: () => {},
    },
  });
  view.root.querySelector<HTMLElement>(".git-panel-file")!.dispatchEvent(contextmenuEvent());
  assert.ok(document.body.querySelector(".git-panel-ctx-menu"));
  view.setGroups(commitGroups());
  assert.equal(document.body.querySelector(".git-panel-ctx-menu"), null);
  view.destroy();
});

test("double-clicking the checkbox stays a checkbox gesture", () => {
  const opened: string[] = [];
  const view = new CommitPanelView({
    title: "Commit",
    groups: commitGroups(),
    handlers: {
      onCancel: () => {},
      onGenerate: () => {},
      onCommit: () => {},
      onOpenDiff: file => opened.push(file.id),
    },
  });
  const checkbox = view.root.querySelector<HTMLInputElement>(".git-panel-check")!;
  checkbox.dispatchEvent(new EventCtor("dblclick"));
  assert.deepEqual(opened, []);
  const row = view.root.querySelector<HTMLElement>(".git-panel-file")!;
  row.dispatchEvent(new EventCtor("dblclick"));
  assert.deepEqual(opened, ["src/a.ts"]);
  view.destroy();
});

const PULL_HANDLERS: import("./PullPanelView.js").PullPanelHandlers = {
  onCancel: () => {},
  onPull: () => {},
  onAbort: () => {},
  onApply: () => {},
  onResolveAi: () => {},
  onEnableCoco: () => {},
  onReviewConflicts: () => {},
};

test("pull panel lists incoming files in the preview state", () => {
  const view = new PullPanelView({ handlers: PULL_HANDLERS });
  view.showPreview(
    [
      { path: "src/pull.ts", status: "modified", insertions: 4, deletions: 2 },
      { path: "docs/n.md", status: "added", insertions: 9, deletions: 0 },
    ],
    2,
    1,
  );
  assert.equal(view.root.querySelector(".git-panel-scope")?.textContent, "2 behind · 1 ahead");
  const rows = [...view.root.querySelectorAll(".git-panel-file")];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.querySelector(".git-panel-dir")?.textContent, "src");
  const buttons = [...view.root.querySelectorAll<HTMLButtonElement>(".git-panel-btn")].map(b => b.textContent);
  assert.deepEqual(buttons, ["Cancel", "Pull"]);
  view.destroy();
});

test("pull panel requires a side for every conflicted file before applying", () => {
  const view = new PullPanelView({ handlers: PULL_HANDLERS });
  view.showMerge(
    ["src/a.ts", "src/b.ts"],
    [{ path: "src/incoming.ts", status: "added", insertions: 1, deletions: 0 }],
  );
  assert.equal(view.getMode(), "merge");
  const apply = [...view.root.querySelectorAll<HTMLButtonElement>(".git-panel-btn")].find(
    button => (button.textContent ?? "").includes("Apply"),
  )!;
  assert.equal(apply.disabled, true);
  assert.deepEqual(view.undecided(), ["src/a.ts", "src/b.ts"]);

  const chips = [...view.root.querySelectorAll<HTMLButtonElement>(".git-panel-chip")];
  assert.equal(chips.length, 6, "three chips per conflicted file");
  chips[1]!.dispatchEvent(new EventCtor("click"));
  assert.equal(chips[1]!.getAttribute("aria-pressed"), "true");
  assert.deepEqual([...view.choices()], [["src/a.ts", "theirs"]]);
  assert.equal(apply.disabled, true, "second file still undecided");

  chips[3]!.dispatchEvent(new EventCtor("click"));
  assert.equal(apply.disabled, false);
  assert.equal(view.undecided().length, 0);
  assert.deepEqual([...view.choices()], [
    ["src/a.ts", "theirs"],
    ["src/b.ts", "mine"],
  ]);
  view.destroy();
});

test("pull panel marks conflicted files with a C badge", () => {
  const view = new PullPanelView({ handlers: PULL_HANDLERS });
  view.showMerge(["src/a.ts"], []);
  const badge = view.root.querySelector(".git-panel-st.is-conflict");
  assert.equal(badge?.textContent, "C");
  assert.equal(view.root.querySelector(".git-panel-section.is-conflict")?.textContent?.includes("Conflicts"), true);
  view.destroy();
});

test("pull panel falls back to an explanatory card when CoCo is off", () => {
  const view = new PullPanelView({ handlers: PULL_HANDLERS });
  view.showAi({ state: "blocked", workspacePath: "E:/repo", files: ["a.ts", "b.ts"] });
  assert.equal(view.getMode(), "ai-blocked");
  assert.match(committedText(view), /CoCo is turned off/);
  assert.match(committedText(view), /No session started — 2 files still conflicted/);
  const labels = [...view.root.querySelectorAll<HTMLButtonElement>(".git-panel-btn")].map(b => b.textContent);
  assert.deepEqual(labels, ["Review conflicts", "Enable CoCo"]);
  assert.equal(view.root.querySelector(".git-panel-ai")?.className.includes("is-off"), true);
  view.destroy();
});

test("pull panel confirms the started session with the merge icon", () => {
  const view = new PullPanelView({ handlers: PULL_HANDLERS });
  view.showAi({ state: "started", workspacePath: "E:/repo", files: ["a.ts"] });
  assert.equal(view.getMode(), "ai-started");
  assert.match(committedText(view), /Task session started/);
  assert.match(committedText(view), /CoCo is resolving 1 conflicted file/);
  assert.ok(view.root.querySelector(".git-panel-ai-icon svg"), "merge icon rendered");
  view.destroy();
});

function mountedPanel(): HTMLElement {
  const panel = document.querySelector<HTMLElement>(".git-panel");
  assert.ok(panel);
  return panel;
}

function action(panel: HTMLElement, label: string): HTMLButtonElement {
  const button = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(item => item.textContent === label);
  assert.ok(button, `Missing action ${label}`);
  return button;
}

function flushPanelTasks(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

test("pull loads a preview, allows empty incoming commits and unlocks on completion", async () => {
  const preview = Promise.withResolvers<Awaited<ReturnType<JellyBotBridge["getPullPreview"]>>>();
  const pull = Promise.withResolvers<Awaited<ReturnType<JellyBotBridge["pullWorkspace"]>>>();
  const busy: boolean[] = [];
  win.jellybot = { getPullPreview: () => preview.promise, pullWorkspace: () => pull.promise };
  const outcome = openPullPanel({
    gitRoot: "E:/repo",
    isChatBusy: () => false,
    startMergeSession: null,
    onEnableCoco: () => {},
    onBusyChange: value => busy.push(value),
  });
  const panel = mountedPanel();
  assert.match(panel.textContent ?? "", /Reading the pull preview/);
  assert.equal(busy.at(-1), true);
  preview.resolve({ isRepo: true, branch: "main", upstream: "origin/main", merging: false, conflicts: [], incoming: [], ahead: 1, behind: 2 });
  await flushPanelTasks();
  assert.match(panel.textContent ?? "", /2 behind · 1 ahead/);
  assert.match(panel.textContent ?? "", /No file changes in the incoming commits/);
  assert.equal(busy.at(-1), false);
  assert.equal(panel.querySelector(".is-spinner"), null);

  action(panel, "Pull").click();
  assert.equal(busy.at(-1), true);
  assert.ok(panel.querySelector(".is-spinner"));
  pull.resolve({ ok: true, updated: true });
  assert.deepEqual(await outcome, { pulled: true, aborted: false });
  assert.equal(document.querySelector(".git-panel"), null, "successful pull closes its panel");
  assert.equal(busy.at(-1), false);
});

test("pull failure keeps the panel open with the error", async () => {
  win.jellybot = {
    getPullPreview: async () => ({ isRepo: true, branch: "main", upstream: "origin/main", merging: false, conflicts: [], incoming: [], ahead: 1, behind: 2 }),
    pullWorkspace: async () => ({ ok: false, updated: false, message: "Could not lock HEAD" }),
  };
  const outcome = openPullPanel({
    gitRoot: "E:/repo",
    isChatBusy: () => false,
    startMergeSession: null,
    onEnableCoco: () => {},
  });
  await flushPanelTasks();
  const panel = mountedPanel();
  action(panel, "Pull").click();
  await flushPanelTasks();
  assert.match(panel.textContent ?? "", /Could not lock HEAD/);
  assert.equal(document.querySelector(".git-panel"), panel);
  action(panel, "Cancel").click();
  assert.deepEqual(await outcome, { pulled: false, aborted: false });
});

test("pull with conflicts keeps the panel open for resolution", async () => {
  win.jellybot = {
    getPullPreview: async () => ({ isRepo: true, branch: "main", upstream: "origin/main", merging: false, conflicts: [], incoming: [], ahead: 1, behind: 2 }),
    pullWorkspace: async () => ({ ok: true, updated: false, conflicts: ["src/a.ts"] }),
  };
  const outcome = openPullPanel({
    gitRoot: "E:/repo",
    isChatBusy: () => false,
    startMergeSession: null,
    onEnableCoco: () => {},
  });
  await flushPanelTasks();
  const panel = mountedPanel();
  action(panel, "Pull").click();
  await flushPanelTasks();
  assert.match(panel.textContent ?? "", /Merge paused/);
  assert.equal(document.querySelector(".git-panel"), panel);
  panel.parentElement?.dispatchEvent(new EventCtor("pointerdown"));
  assert.deepEqual(await outcome, { pulled: false, aborted: false });
});

test("commit shows pending and clean states without an active message form", async () => {
  const changes = Promise.withResolvers<Awaited<ReturnType<JellyBotBridge["listWorkingTreeChanges"]>>>();
  const busy: boolean[] = [];
  win.jellybot = {
    listWorkingTreeChanges: () => changes.promise,
    getGitBranchInfo: async () => ({ branch: "main" }),
    collaborativeBranch: async () => ({ repositories: [] }),
  };
  const outcome = openCommitPanel({
    workspacePath: "E:/repo",
    workspaceName: "repo",
    isChatBusy: () => false,
    onBusyChange: value => busy.push(value),
  });
  const panel = mountedPanel();
  assert.match(panel.textContent ?? "", /Reading changed files/);
  assert.equal(busy.at(-1), true);
  assert.equal(panel.querySelector("textarea")?.hidden, true);
  assert.equal(panel.querySelector<HTMLElement>(".git-panel-select-all")?.hidden, true);
  changes.resolve({ isRepo: true, files: [], insertions: 0, deletions: 0 });
  await flushPanelTasks();
  assert.match(panel.textContent ?? "", /Nothing to commit/);
  assert.equal(panel.querySelector(".git-panel-empty .is-spinner"), null);
  assert.equal(panel.querySelector<HTMLElement>(".git-panel-select-all")?.hidden, true);
  assert.equal(busy.at(-1), false);
  action(panel, "Close").click();
  assert.deepEqual(await outcome, { committed: false });
});

test("SVN Commit excludes conflicted files from select all and from the commit", async () => {
  const [file, conflict] = commitGroups()[0]!.files;
  win.jellybot = {
    listWorkingTreeChanges: async () => ({
      isRepo: true,
      vcs: "svn",
      files: [file, { ...conflict, conflicted: true }],
    }),
    getGitBranchInfo: async () => ({ branch: "main" }),
    collaborativeBranch: async () => ({ repositories: [] }),
    async commitWorkspace({ paths, message }: { paths: string[]; message: string }) {
      assert.deepEqual(paths, [file!.path]);
      return { hash: "r8", shortHash: "r8", subject: message, message };
    },
  };
  const outcome = openCommitPanel({
    workspacePath: "E:/repo",
    workspaceName: "repo",
    isChatBusy: () => false,
  });
  await flushPanelTasks();
  const panel = mountedPanel();
  assert.equal(panel.getAttribute("aria-label"), "SVN Commit · repo");
  assert.equal(panel.querySelector(".git-panel-note")?.textContent, "Conflict");
  assert.equal(panel.querySelector(".git-panel-file.is-static input"), null);
  const master = panel.querySelector<HTMLInputElement>(".git-panel-select-all input")!;
  assert.equal(master.checked, true);
  master.checked = false;
  master.dispatchEvent(new EventCtor("change"));
  master.checked = true;
  master.dispatchEvent(new EventCtor("change"));
  assert.equal(panel.querySelector(".git-panel-selection-count")?.textContent, "1 / 1 selected");
  const editor = panel.querySelector<HTMLTextAreaElement>("textarea")!;
  editor.value = "Update the working copy";
  editor.dispatchEvent(new EventCtor("input"));
  action(panel, "Commit").click();
  await flushPanelTasks();
  assert.equal(document.querySelector(".git-panel"), null);
  assert.deepEqual(await outcome, {
    committed: true,
    hash: "r8",
    shortHash: "r8",
    subject: "Update the working copy",
    message: "Update the working copy",
    vcs: "svn",
  });
});

test("commit preserves the selected files and message when a failure is retried", async () => {
  const busy: boolean[] = [];
  let attempts = 0;
  win.jellybot = {
    listWorkingTreeChanges: async () => ({ isRepo: true, files: [commitGroups()[0]!.files[0]] }),
    getGitBranchInfo: async () => ({ branch: "main" }),
    collaborativeBranch: async () => ({ repositories: [] }),
    async commitWorkspace({ paths, message }: { paths: string[]; message: string }) {
      assert.deepEqual(paths, ["src/deep/a.ts"]);
      assert.equal(message, "Update the file");
      if (++attempts === 1) throw new Error("Could not lock HEAD");
      return { hash: "abcdef", shortHash: "abc", subject: message, message };
    },
  };
  const outcome = openCommitPanel({
    workspacePath: "E:/repo",
    workspaceName: "repo",
    isChatBusy: () => false,
    onBusyChange: value => busy.push(value),
  });
  await flushPanelTasks();
  const panel = mountedPanel();
  const editor = panel.querySelector<HTMLTextAreaElement>("textarea")!;
  editor.value = "Update the file";
  editor.dispatchEvent(new EventCtor("input"));
  const commit = action(panel, "Commit");
  commit.click();
  assert.equal(busy.at(-1), true);
  assert.match(panel.querySelector(".git-panel-scope")?.textContent ?? "", /1 file/);
  await flushPanelTasks();
  assert.equal(busy.at(-1), false);
  assert.equal(commit.disabled, false);
  assert.equal(editor.value, "Update the file");
  assert.match(panel.textContent ?? "", /Could not lock HEAD/);
  commit.click();
  await flushPanelTasks();
  assert.equal(busy.at(-1), false);
  assert.equal(document.querySelector(".git-panel"), null);
  assert.deepEqual(await outcome, {
    committed: true,
    hash: "abcdef",
    shortHash: "abc",
    subject: "Update the file",
    message: "Update the file",
    vcs: "git",
  });
});
