/**
 * Solution Outline — UE engine project redirect.
 *
 * UBT lists the engine's own project inside the *game's*
 * Intermediate/ProjectFiles, so the generic "two levels up" rule would make
 * the Engine node list game code. These tests drive the real expand path and
 * assert which directory the node asks main to list.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import { debugButtonTitle } from "../../../debug/debugCopy.js";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  // Badge patching / selection sync query rows via CSS.escape.
  CSS: { escape: (value: string) => value },
});
// Skip the expand height animation: the sync path renders immediately.
Object.assign(dom.window, {
  matchMedia: () => ({ matches: true }),
  CSS: { escape: (value: string) => value },
});

type SolutionOutlineControllerT =
  typeof import("./SolutionOutlineController.js")["SolutionOutlineController"];
let SolutionOutlineController: SolutionOutlineControllerT;

test.before(async () => {
  ({ SolutionOutlineController } = await import(
    "./SolutionOutlineController.js"
  ));
});

const WORKSPACE = "E:/work/NF";
const ENGINE_ROOT = "E:/work/UnrealEngine/Engine";
const CPP_GUID = "{8BC9CEB8-8B4A-11D0-8D11-00A0C91BC942}";

/** UE game solution: the game and the engine project side by side. */
function slnText(engineProjectPath: string): string {
  return [
    "Microsoft Visual Studio Solution File, Format Version 12.00",
    `Project("${CPP_GUID}") = "NF", "Intermediate\\ProjectFiles\\NF.vcxproj", "{AAAAAAAA-0000-0000-0000-000000000001}"`,
    "EndProject",
    `Project("${CPP_GUID}") = "Engine", "${engineProjectPath}", "{AAAAAAAA-0000-0000-0000-000000000002}"`,
    "EndProject",
    "Global",
    "EndGlobal",
  ].join("\r\n");
}

type Harness = {
  controller: InstanceType<SolutionOutlineControllerT>;
  listed: string[];
};

async function mountOutline(options: {
  engineRoot: string | null;
  engineProjectPath?: string;
  debugKind?: "unreal" | "electron" | "web" | null;
  programs?: Array<{ id: string; name: string; path: string; sourceRoot: string; kind: "native" | "managed" }>;
}): Promise<Harness> {
  const listed: string[] = [];
  const debugKind = options.debugKind === undefined ? "unreal" : options.debugKind;
  Object.assign(window, {
    jellybot: {
      platform: "win32",
      getUnrealWorkspace: async () => ({ ok: true, workspace: options.programs ? { engineRoot: options.engineRoot, projects: options.programs } : null }),
      getDevTaskConfig: async () => ({
        ok: true as const,
        tasks: [] as Array<{ id: string; command: string }>,
        debugSupported: debugKind !== null,
        debugKind,
      }),
      listDevModeDir: async (path: string) => {
        listed.push(path);
        if (path === WORKSPACE) {
          return {
            ok: true as const,
            entries: [
              {
                kind: "file" as const,
                name: "NF.sln",
                path: `${WORKSPACE}/NF.sln`,
                ext: "sln",
              },
            ],
          };
        }
        return { ok: true as const, entries: [] };
      },
      readTextFile: async () => ({
        ok: true as const,
        content: slnText(
          options.engineProjectPath ??
            "Intermediate\\ProjectFiles\\Engine.vcxproj",
        ),
      }),
      getDevModeEngineRoot: async () => options.engineRoot,
      searchDevModeFiles: async (ws: string, query: string) => ({
        ok: true as const,
        files: query
          ? [{ path: `${ws}/Source/NF/NFCharacter.cpp`, rel: "Source/NF/NFCharacter.cpp" }]
          : [],
        truncated: false,
      }),
      readDevModeProjectFile: async () => ({
        ok: false as const,
        message: "not needed",
      }),
      getVcsStatus: async () => ({ ok: false as const }),
    },
  });

  const controller = new SolutionOutlineController({ onOpenFile: () => undefined });
  await controller.setWorkspace(WORKSPACE);
  listed.length = 0; // drop the workspace listing done during load
  return { controller, listed };
}

test("Programs includes native targets and managed libraries omitted by the solution", async () => {
  const nativeRoot = `${ENGINE_ROOT}/Source/Programs/UnrealInsights`;
  const managedRoot = `${ENGINE_ROOT}/Source/Programs/Shared/EpicGames.Core`;
  const { controller, listed } = await mountOutline({ engineRoot: ENGINE_ROOT, programs: [
    { id: "native", name: "UnrealInsights", path: `${nativeRoot}/UnrealInsights.Target.cs`, sourceRoot: nativeRoot, kind: "native" },
    { id: "managed", name: "EpicGames.Core", path: `${managedRoot}/EpicGames.Core.csproj`, sourceRoot: managedRoot, kind: "managed" },
  ] });
  try {
    clickRow(controller, "Programs");
    clickRow(controller, "UnrealInsights");
    await new Promise(resolve => setTimeout(resolve, 10));
    clickRow(controller, "EpicGames.Core");
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(listed.includes(nativeRoot)); assert.ok(listed.includes(managedRoot));
  } finally { controller.destroy(); }
});

function clickRow(
  controller: InstanceType<SolutionOutlineControllerT>,
  label: string,
): void {
  const row = [...controller.root.querySelectorAll(".devmode-tree-row")].find(
    (el) => el.querySelector(".devmode-tree-label")?.textContent === label,
  );
  assert.ok(row, `no outline row labelled ${label}`);
  (row as HTMLElement).dispatchEvent(
    new dom.window.Event("click", { bubbles: true }),
  );
}

test("Engine expands into the engine tree, not the game root", async () => {
  const { controller, listed } = await mountOutline({ engineRoot: ENGINE_ROOT });

  clickRow(controller, "Engine");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(listed, [ENGINE_ROOT]);

  // The game project still resolves two levels up to its own root.
  listed.length = 0;
  clickRow(controller, "NF");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(listed, [WORKSPACE]);
  controller.destroy();
});

test("marks the engine project external so saves stay blocked", async () => {
  const { controller } = await mountOutline({ engineRoot: ENGINE_ROOT });
  const rows = [...controller.root.querySelectorAll(".devmode-tree-row")];
  const engineRow = rows.find(
    (el) => el.querySelector(".devmode-tree-label")?.textContent === "Engine",
  );
  const gameRow = rows.find(
    (el) => el.querySelector(".devmode-tree-label")?.textContent === "NF",
  );
  assert.ok(engineRow?.querySelector(".devmode-tree-external"));
  assert.equal(gameRow?.querySelector(".devmode-tree-external"), null);
  controller.destroy();
});

test("keeps the engine project in its own tree when the sln points there", async () => {
  const { controller, listed } = await mountOutline({
    engineRoot: ENGINE_ROOT,
    engineProjectPath:
      "..\\UnrealEngine\\Engine\\Intermediate\\ProjectFiles\\UE5.vcxproj",
  });

  clickRow(controller, "Engine");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(listed, [ENGINE_ROOT]);
  controller.destroy();
});

test("falls back to the path rule when no engine root resolves", async () => {
  const { controller, listed } = await mountOutline({ engineRoot: null });

  clickRow(controller, "Engine");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(listed, [WORKSPACE]);
  controller.destroy();
});

test("the refresh button follows the workspace", async () => {
  const { controller } = await mountOutline({
    engineRoot: null,
    debugKind: "electron",
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const refresh = controller.refreshButton;
  assert.equal(refresh.getAttribute("aria-label"), "Refresh");
  assert.equal(refresh.disabled, false);
  await controller.setWorkspace(null);
  assert.equal(refresh.disabled, true);
  controller.destroy();
});

type DirEntry = {
  kind: "dir" | "file";
  name: string;
  path: string;
  ext: string;
  executable?: boolean;
};

/** Plain folder tree (no .sln) whose listings can change between refreshes. */
async function mountFolderTree(listings: Map<string, DirEntry[]>): Promise<
  InstanceType<SolutionOutlineControllerT>
> {
  return mountFolderTreeWith(listings, {});
}

type FolderTreeHooks = {
  platform?: string;
  onOpenFile?: (path: string) => void;
  runDevModeExecutable?: (path: string) => Promise<{ ok: boolean; message?: string }>;
  alertDialog?: (req: { message: string; title?: string; type?: string }) => Promise<void>;
};

async function mountFolderTreeWith(
  listings: Map<string, DirEntry[]>,
  hooks: FolderTreeHooks,
): Promise<InstanceType<SolutionOutlineControllerT>> {
  Object.assign(window, {
    jellybot: {
      platform: hooks.platform ?? "win32",
      getDevTaskConfig: async () => ({
        ok: true as const,
        tasks: [] as Array<{ id: string; command: string }>,
        debugSupported: false,
        debugKind: null,
      }),
      listDevModeDir: async (path: string) => ({
        ok: true as const,
        entries: listings.get(path) ?? [],
      }),
      getVcsStatus: async () => ({ ok: false as const }),
      revealPath: async () => undefined,
      runDevModeExecutable: hooks.runDevModeExecutable ?? (async () => ({ ok: true as const })),
      ...(hooks.alertDialog ? { alertDialog: hooks.alertDialog } : {}),
    },
  });
  const controller = new SolutionOutlineController({
    onOpenFile: hooks.onOpenFile ?? (() => undefined),
  });
  await controller.setWorkspace(WORKSPACE);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return controller;
}

function fileEntry(name: string): DirEntry {
  return {
    kind: "file",
    name,
    path: `${WORKSPACE}/src/${name}`,
    ext: "cpp",
  };
}

test("header refresh reloads an expanded directory from disk", async () => {
  const src = `${WORKSPACE}/src`;
  const listings = new Map<string, DirEntry[]>([
    [
      WORKSPACE,
      [{ kind: "dir", name: "src", path: src, ext: "" }],
    ],
    [src, [fileEntry("a.cpp")]],
  ]);
  const controller = await mountFolderTree(listings);
  clickRow(controller, "src");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(controller.root.textContent ?? "", /a\.cpp/);

  listings.set(src, [fileEntry("a.cpp"), fileEntry("b.cpp")]);
  const refresh = controller.refreshButton;
  refresh.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const text = controller.root.textContent ?? "";
  assert.match(text, /a\.cpp/);
  assert.match(text, /b\.cpp/);

  listings.set(src, [fileEntry("b.cpp")]);
  refresh.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = controller.root.textContent ?? "";
  assert.doesNotMatch(after, /a\.cpp/);
  assert.match(after, /b\.cpp/);
  controller.destroy();
});

test("folder context menu refresh reloads that directory", async () => {
  const src = `${WORKSPACE}/src`;
  const listings = new Map<string, DirEntry[]>([
    [
      WORKSPACE,
      [{ kind: "dir", name: "src", path: src, ext: "" }],
    ],
    [src, [fileEntry("a.cpp")]],
  ]);
  const controller = await mountFolderTree(listings);
  clickRow(controller, "src");
  await new Promise((resolve) => setTimeout(resolve, 0));

  listings.set(src, [fileEntry("a.cpp"), fileEntry("c.cpp")]);
  const row = [...controller.root.querySelectorAll(".devmode-tree-row")].find(
    (el) => el.querySelector(".devmode-tree-label")?.textContent === "src",
  );
  assert.ok(row);
  const menuEvent = new window.Event("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(menuEvent, { clientX: 12, clientY: 12 });
  row.dispatchEvent(menuEvent);
  const item = [...document.querySelectorAll(".devmode-ctx-item")].find(
    (el) => el.textContent?.startsWith("Refresh"),
  ) as HTMLButtonElement | undefined;
  assert.ok(item);
  item.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(controller.root.textContent ?? "", /c\.cpp/);
  assert.equal(document.querySelector(".devmode-ctx-menu"), null);
  controller.destroy();
});

function rowByLabel(
  controller: InstanceType<SolutionOutlineControllerT>,
  label: string,
): HTMLElement {
  const row = [...controller.root.querySelectorAll(".devmode-tree-row")].find(
    (el) => el.querySelector(".devmode-tree-label")?.textContent === label,
  );
  assert.ok(row, `no outline row labelled ${label}`);
  return row as HTMLElement;
}

test("executable file: click selects only, double-click runs it", async () => {
  const src = `${WORKSPACE}/src`;
  const listings = new Map<string, DirEntry[]>([
    [WORKSPACE, [{ kind: "dir", name: "src", path: src, ext: "" }]],
    [
      src,
      [
        fileEntry("a.cpp"),
        {
          kind: "file",
          name: "tool.exe",
          path: `${src}/tool.exe`,
          ext: "exe",
          executable: true,
        },
      ],
    ],
  ]);
  const opened: string[] = [];
  const ran: string[] = [];
  const controller = await mountFolderTreeWith(listings, {
    onOpenFile: (p) => opened.push(p),
    runDevModeExecutable: async (p) => {
      ran.push(p);
      return { ok: true };
    },
  });
  clickRow(controller, "src");
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Plain file: click still opens the editor tab.
  clickRow(controller, "a.cpp");
  assert.deepEqual(opened, [`${src}/a.cpp`]);

  // Executable: click selects only — no editor open, no binary-file error.
  clickRow(controller, "tool.exe");
  assert.deepEqual(opened, [`${src}/a.cpp`]);
  const row = rowByLabel(controller, "tool.exe");
  assert.ok(row.classList.contains("is-selected"));
  assert.match(row.getAttribute("title") ?? "", /Double-click to run/);

  // Double-click (row re-created by the selection render) launches via IPC.
  rowByLabel(controller, "tool.exe").dispatchEvent(
    new window.Event("dblclick", { bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ran, [`${src}/tool.exe`]);
  controller.destroy();
});

test("executable context menu: Run entry, absent for plain files", async () => {
  const src = `${WORKSPACE}/src`;
  const listings = new Map<string, DirEntry[]>([
    [WORKSPACE, [{ kind: "dir", name: "src", path: src, ext: "" }]],
    [
      src,
      [
        fileEntry("a.cpp"),
        {
          kind: "file",
          name: "tool.exe",
          path: `${src}/tool.exe`,
          ext: "exe",
          executable: true,
        },
      ],
    ],
  ]);
  const ran: string[] = [];
  const controller = await mountFolderTreeWith(listings, {
    runDevModeExecutable: async (p) => {
      ran.push(p);
      return { ok: true };
    },
  });
  clickRow(controller, "src");
  await new Promise((resolve) => setTimeout(resolve, 0));

  const openMenu = (label: string): void => {
    const menuEvent = new window.Event("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(menuEvent, { clientX: 8, clientY: 8 });
    rowByLabel(controller, label).dispatchEvent(menuEvent);
  };
  const itemLabels = (): string[] =>
    [...document.querySelectorAll(".devmode-ctx-item")].map(
      (el) => el.textContent ?? "",
    );

  openMenu("a.cpp");
  assert.ok(!itemLabels().includes("Run"));
  document.querySelector(".devmode-ctx-menu")?.remove();

  openMenu("tool.exe");
  const labels = itemLabels();
  assert.ok(labels.includes("Run"));
  assert.ok(labels.includes("Open in Editor"));
  const runItem = [...document.querySelectorAll(".devmode-ctx-item")].find(
    (el) => el.textContent === "Run",
  ) as HTMLButtonElement | undefined;
  assert.ok(runItem);
  runItem.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(ran, [`${src}/tool.exe`]);
  controller.destroy();
});

test("launch failure surfaces an alert dialog, not silence", async () => {
  const src = `${WORKSPACE}/src`;
  const listings = new Map<string, DirEntry[]>([
    [WORKSPACE, [{ kind: "dir", name: "src", path: src, ext: "" }]],
    [
      src,
      [
        {
          kind: "file",
          name: "build.sh",
          path: `${src}/build.sh`,
          ext: "sh",
          executable: true,
        },
      ],
    ],
  ]);
  const alerts: Array<{ title?: string; message: string }> = [];
  const controller = await mountFolderTreeWith(listings, {
    runDevModeExecutable: async () => ({
      ok: false,
      message: "file is not executable (chmod +x to run it)",
    }),
    alertDialog: async (req) => {
      alerts.push(req);
    },
  });
  clickRow(controller, "src");
  await new Promise((resolve) => setTimeout(resolve, 0));
  rowByLabel(controller, "build.sh").dispatchEvent(
    new window.Event("dblclick", { bubbles: true }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0]?.title, "Run executable");
  assert.match(alerts[0]?.message ?? "", /chmod \+x/);
  controller.destroy();
});

// Deploy uses the same config watcher and task runner as Build; no shell runs
// in this harness.
type DeployConfigReply = {
  ok: true;
  tasks: Array<{ id: string; command: string }>;
  debugSupported: false;
  debugKind: null;
} | { ok: false; message: string };
const deployConfig = (command?: string): DeployConfigReply => ({
  ok: true, tasks: command ? [{ id: "deploy", command }] : [],
  debugSupported: false, debugKind: null,
});
const settleDeploy = () => new Promise(resolve => setTimeout(resolve, 0));

function deployHarness(getConfig: (root: string) => Promise<DeployConfigReply>) {
  const configCommands: Array<string | null> = [];
  const states: Array<[string, boolean, boolean]> = [];
  const runs: Array<[string, string]> = [];
  const reveals: string[] = [];
  const alerts: string[] = [];
  let exit: (snap: { task: string; workspacePath: string; status: string }) => void = () => {};
  let startFailure = false;
  Object.assign(window, {
    alert: (message: string) => alerts.push(message),
    jellybot: {
      getDevTaskConfig: getConfig,
      getDevTaskState: async () => ({ active: [], last: {} }),
      listDevModeDir: async () => ({ ok: true, entries: [] }),
      getVcsStatus: async () => ({ ok: false }),
      onDevTaskExit: (handler: typeof exit) => { exit = handler; return () => {}; },
      runDevTask: async (root: string, task: string) => {
        runs.push([root, task]);
        return startFailure ? { ok: false, message: "start failed" } : { ok: true, runId: "d1" };
      },
    },
  });
  const controller = new SolutionOutlineController({
    onOpenFile: () => {},
    onDeployConfigChange: command => configCommands.push(command),
    onTaskStateChange: (task, running, failed) => states.push([task, running, failed]),
    onTaskRun: task => reveals.push(task),
  });
  return { controller, configCommands, states, runs, reveals, alerts,
    failStart: (failed: boolean) => { startFailure = failed; },
    emitExit: (status: string) => exit({ task: "deploy", workspacePath: WORKSPACE, status }),
  };
}

test("deploy config additions, removals and validation errors update availability", async () => {
  let config = deployConfig();
  const h = deployHarness(async () => config);
  await h.controller.setWorkspace(WORKSPACE);
  await settleDeploy();
  assert.equal(h.configCommands.at(-1), null);
  const reload = async () => {
    h.controller.handleFsEvent({ rootPath: WORKSPACE,
      events: [{ path: `${WORKSPACE}/.larry/tasks.json`, kind: "change" }] });
    await new Promise(resolve => setTimeout(resolve, 340));
  };
  config = deployConfig("npm run deploy");
  await reload();
  assert.equal(h.configCommands.at(-1), "npm run deploy");
  config = { ok: false, message: "invalid config" };
  await reload();
  assert.equal(h.configCommands.at(-1), null);
  config = deployConfig("npm run ship");
  await reload();
  assert.equal(h.configCommands.at(-1), "npm run ship");
  config = deployConfig();
  await reload();
  assert.equal(h.configCommands.at(-1), null);
  h.controller.destroy();
});

test("deploy runs the configured task once, handles failure/retry and resets on workspace switch", async () => {
  const h = deployHarness(async () => deployConfig("npm run deploy"));
  await h.controller.setWorkspace(WORKSPACE);
  await settleDeploy();
  h.failStart(true);
  h.controller.runDeploy();
  await settleDeploy();
  assert.deepEqual(h.states.at(-1), ["deploy", false, false]);
  assert.match(h.alerts[0], /start failed/);
  h.failStart(false);
  h.controller.runDeploy();
  h.controller.runDeploy();
  await settleDeploy();
  assert.deepEqual(h.runs, [[WORKSPACE, "deploy"], [WORKSPACE, "deploy"]]);
  assert.equal(h.reveals.at(-1), "deploy");
  assert.deepEqual(h.states.at(-1), ["deploy", true, false]);
  h.emitExit("failed");
  assert.deepEqual(h.states.at(-1), ["deploy", false, true]);
  h.controller.runDeploy();
  await settleDeploy();
  assert.deepEqual(h.states.at(-1), ["deploy", true, false]);
  h.emitExit("done");
  assert.deepEqual(h.states.at(-1), ["deploy", false, false]);
  await h.controller.setWorkspace(null);
  assert.equal(h.configCommands.at(-1), null);
  assert.deepEqual(h.states.at(-1), ["deploy", false, false]);
  h.controller.destroy();
});

test("a stale workspace config cannot reveal Deploy after switching projects", async () => {
  let resolveOld!: (reply: DeployConfigReply) => void;
  const old = new Promise<DeployConfigReply>(resolve => { resolveOld = resolve; });
  const h = deployHarness(async root => root === WORKSPACE ? old : deployConfig());
  await h.controller.setWorkspace(WORKSPACE);
  await h.controller.setWorkspace("/other");
  resolveOld(deployConfig("npm run deploy-old"));
  await settleDeploy();
  assert.equal(h.configCommands.at(-1), null);
  assert.ok(!h.configCommands.includes("npm run deploy-old"));
  h.controller.destroy();
});

test("vcs status re-badges the affected rows without rebuilding the tree", async () => {
  type Status = { ok: boolean; vcs: "git"; entries: Array<{ path: string; status: string }> };
  let status: Status = { ok: true, vcs: "git", entries: [] };
  const readme = `${WORKSPACE}/README.md`;
  const listings = new Map<string, DirEntry[]>([
    [
      WORKSPACE,
      [
        { kind: "dir", name: "src", path: `${WORKSPACE}/src`, ext: "" },
        { kind: "file", name: "README.md", path: readme, ext: "md" },
      ],
    ],
  ]);
  Object.assign(window, {
    jellybot: {
      platform: "win32",
      getDevTaskConfig: async () => ({
        ok: true as const,
        tasks: [] as Array<{ id: string; command: string }>,
        debugSupported: false,
        debugKind: null,
      }),
      listDevModeDir: async (path: string) => ({
        ok: true as const,
        entries: listings.get(path) ?? [],
      }),
      getVcsStatus: async () => status,
      revealPath: async () => undefined,
      runDevModeExecutable: async () => ({ ok: true }),
    },
  });
  const controller = new SolutionOutlineController({ onOpenFile: () => undefined });
  await controller.setWorkspace(WORKSPACE);
  // Entry-time status run (clean repo): kind flips none→git, no marks move.
  await new Promise(resolve => setTimeout(resolve, 400));
  const body = controller.root.querySelector(".devmode-outline-body") as HTMLElement;
  const row = body.querySelector(`[data-key="file:${readme}"]`) as HTMLElement;
  assert.ok(row, "file row rendered");
  assert.ok(!row.querySelector(".devmode-tree-st"), "clean file carries no chip");

  // File goes dirty → chip appears on the SAME row element (no rebuild).
  status = { ok: true, vcs: "git", entries: [{ path: readme, status: "M" }] };
  controller.handleVcsChanged();
  await new Promise(resolve => setTimeout(resolve, 250));
  const dirtyRow = body.querySelector(`[data-key="file:${readme}"]`);
  assert.equal(dirtyRow, row, "row was patched in place, not rebuilt");
  const chip = row.querySelector(".devmode-tree-st");
  assert.ok(chip, "chip patched onto the row");
  assert.match(chip!.className, /devmode-st-m/);

  // Back to clean → chip removed, still the same row element.
  status = { ok: true, vcs: "git", entries: [] };
  controller.handleVcsChanged();
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(body.querySelector(`[data-key="file:${readme}"]`), row);
  assert.ok(!row.querySelector(".devmode-tree-st"), "chip removed in place");
  controller.destroy();
});

test("syncSelection moves the highlight without rebuilding the tree", async () => {
  const listings = new Map<string, DirEntry[]>([
    [
      WORKSPACE,
      [
        { kind: "dir", name: "src", path: `${WORKSPACE}/src`, ext: "" },
        { kind: "file", name: "README.md", path: `${WORKSPACE}/README.md`, ext: "md" },
        { kind: "file", name: "NOTES.md", path: `${WORKSPACE}/NOTES.md`, ext: "md" },
      ],
    ],
  ]);
  const controller = await mountFolderTree(listings);
  const body = controller.root.querySelector(".devmode-outline-body") as HTMLElement;
  const readme = body.querySelector('[data-key="file:E:/work/NF/README.md"]') as HTMLElement;
  const notes = body.querySelector('[data-key="file:E:/work/NF/NOTES.md"]') as HTMLElement;
  assert.ok(readme && notes, "file rows rendered");

  controller.syncSelection("E:\\work\\NF\\README.md");
  assert.ok(readme.classList.contains("is-selected"), "readme highlighted");
  assert.equal(
    body.querySelector('[data-key="file:E:/work/NF/README.md"]'),
    readme,
    "row identity kept",
  );

  controller.syncSelection("E:/work/NF/NOTES.md");
  assert.ok(notes.classList.contains("is-selected"), "notes highlighted");
  assert.ok(!readme.classList.contains("is-selected"), "readme un-highlighted");
  assert.equal(
    body.querySelector('[data-key="file:E:/work/NF/NOTES.md"]'),
    notes,
    "row identity kept",
  );
  controller.destroy();
});

test("a content-only change event (file read on Windows) leaves the tree alone", async () => {
  const src = `${WORKSPACE}/src`;
  const listed: string[] = [];
  const listings = new Map<string, DirEntry[]>([
    [WORKSPACE, [{ kind: "dir", name: "src", path: src, ext: "" }]],
    [src, [fileEntry("a.cpp")]],
  ]);
  const controller = await mountFolderTree(listings);
  clickRow(controller, "src");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const jb = (window as unknown as { jellybot: Record<string, unknown> }).jellybot;
  const list = jb.listDevModeDir as (p: string) => Promise<unknown>;
  jb.listDevModeDir = (p: string) => {
    listed.push(p);
    return list(p);
  };
  const row = rowByLabel(controller, "a.cpp");

  controller.handleFsEvent({
    rootPath: WORKSPACE,
    events: [{ path: `${src}/a.cpp`, kind: "change" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(listed, [], "no directory re-list");
  assert.equal(rowByLabel(controller, "a.cpp"), row, "row not rebuilt");
  controller.destroy();
});

test("watch reload renders once — no interim Loading row", async () => {
  const src = `${WORKSPACE}/src`;
  const listings = new Map<string, DirEntry[]>([
    [WORKSPACE, [{ kind: "dir", name: "src", path: src, ext: "" }]],
    [src, [fileEntry("a.cpp")]],
  ]);
  const controller = await mountFolderTree(listings);
  clickRow(controller, "src");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const jb = (window as unknown as { jellybot: Record<string, unknown> }).jellybot;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  jb.listDevModeDir = async (p: string) => {
    await gate;
    return { ok: true as const, entries: listings.get(p) ?? [] };
  };
  listings.set(src, [fileEntry("a.cpp"), fileEntry("b.cpp")]);

  controller.handleFsEvent({
    rootPath: WORKSPACE,
    events: [{ path: `${src}/b.cpp`, kind: "add" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 260));
  const midway = controller.root.textContent ?? "";
  assert.doesNotMatch(midway, /Loading…/);
  assert.match(midway, /a\.cpp/, "old rows stay while the listing is in flight");

  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(controller.root.textContent ?? "", /b\.cpp/);
  controller.destroy();
});

test("project item-tree dirs are not re-listed from disk on watch events", async () => {
  const listed: string[] = [];
  const vcxproj = [
    '<Project DefaultTargets="Build" ToolsVersion="17.0">',
    "  <ItemGroup>",
    '    <ClCompile Include="..\\..\\Source\\NF\\A.cpp" />',
    "  </ItemGroup>",
    "</Project>",
  ].join("\r\n");
  Object.assign(window, {
    jellybot: {
      platform: "win32",
      getDevTaskConfig: async () => ({
        ok: true as const,
        tasks: [] as Array<{ id: string; command: string }>,
        debugSupported: false,
        debugKind: null,
      }),
      listDevModeDir: async (path: string) => {
        listed.push(path);
        if (path === WORKSPACE) {
          return {
            ok: true as const,
            entries: [
              { kind: "file" as const, name: "NF.sln", path: `${WORKSPACE}/NF.sln`, ext: "sln" },
            ],
          };
        }
        return {
          ok: true as const,
          entries: [
            { kind: "file" as const, name: "A.cpp", path: `${path}/A.cpp`, ext: "cpp" },
            { kind: "file" as const, name: "Extra.cpp", path: `${path}/Extra.cpp`, ext: "cpp" },
          ],
        };
      },
      readTextFile: async () => ({
        ok: true as const,
        content: [
          "Microsoft Visual Studio Solution File, Format Version 12.00",
          `Project("${CPP_GUID}") = "NF", "Intermediate\\ProjectFiles\\NF.vcxproj", "{AAAAAAAA-0000-0000-0000-000000000001}"`,
          "EndProject",
        ].join("\r\n"),
      }),
      getDevModeEngineRoot: async () => null,
      readDevModeProjectFile: async () => ({ ok: true as const, content: vcxproj }),
      getVcsStatus: async () => ({ ok: false as const }),
    },
  });
  const controller = new SolutionOutlineController({ onOpenFile: () => undefined });
  await controller.setWorkspace(WORKSPACE);
  const body = controller.root.querySelector(".devmode-outline-body") as HTMLElement;
  const click = (key: string): void => {
    const row = body.querySelector(`[data-key="${key}"]`);
    assert.ok(row, `no row ${key}`);
    row.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  };
  clickRow(controller, "NF");
  await new Promise((resolve) => setTimeout(resolve, 0));
  click(`dir:${WORKSPACE}/Source`);
  click(`dir:${WORKSPACE}/Source/NF`);
  assert.match(controller.root.textContent ?? "", /A\.cpp/);
  listed.length = 0;

  controller.handleFsEvent({
    rootPath: WORKSPACE,
    events: [{ path: `${WORKSPACE}/Source/NF/Extra.cpp`, kind: "add" }],
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(listed, [], "item-tree dir not re-listed");
  const text = controller.root.textContent ?? "";
  assert.match(text, /A\.cpp/);
  assert.doesNotMatch(text, /Extra\.cpp/, "tree still mirrors the project file");
  controller.destroy();
});
