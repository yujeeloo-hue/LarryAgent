/**
 * Top context pill — DOM rendering (prompt / task shapes, fold, reset).
 */
import assert from "node:assert/strict";
import Module from "node:module";
import test, { mock } from "node:test";
import { parseHTML } from "linkedom";

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

type ContextPillControllerT =
  typeof import("./contextPill.js")["ContextPillController"];
let ContextPillController: ContextPillControllerT;
let computeEditorStatusMode: import("./contextPill.js")["computeEditorStatusMode"];
let ContextPillSnapshotT =
  import("./contextPill.js")["ContextPillSnapshot"];

test.before(async () => {
  ({ ContextPillController, computeEditorStatusMode } = await import(
    "./contextPill.js"
  ));
});

function snapshot(
  overrides: Partial<ContextPillSnapshotT> = {},
): ContextPillSnapshotT {
  return {
    running: false,
    lastUserText: null,
    lastUserFiles: null,
    progressText: "",
    plan: null,
    promptVisible: false,
    ...overrides,
  };
}

function makePill() {
  const pill = new ContextPillController();
  const host = document.createElement("div");
  pill.mount(host);
  return { pill, host };
}

test.afterEach(() => {
  // Belt and braces: unref any stragglers between tests.
  document.body.replaceChildren();
});

test("hidden until the first meaningful snapshot", () => {
  const { pill, host } = makePill();
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  assert.ok(root.hidden, "starts hidden with an empty snapshot");
  pill.update(snapshot());
  assert.ok(root.hidden, "still hidden with nothing to show");
  pill.destroy();
});

test("prompt mode: single-line text, no spinner, title carries the full text", () => {
  const { pill, host } = makePill();
  pill.update(snapshot({ lastUserText: "检查 GameplayAbility 的冷却计算" }));
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  assert.equal(root.hidden, false);
  assert.ok(root.classList.contains("is-prompt"));
  assert.ok(!root.classList.contains("is-task"));
  assert.equal(
    root.querySelector<HTMLElement>(".ctxpill-text")!.textContent,
    "检查 GameplayAbility 的冷却计算",
  );
  // Spinner visibility is CSS-driven (.is-task); DOM contract = classes.
  assert.ok(!root.classList.contains("is-task"));
  assert.ok(
    !root.classList.contains("is-running"),
    "idle prompt shows no spinner",
  );
  assert.equal(root.title, "检查 GameplayAbility 的冷却计算");

  // Running without a plan → still the prompt, plus the running spinner.
  pill.update(snapshot({ running: true, lastUserText: "检查 GAS 冷却" }));
  assert.ok(root.classList.contains("is-prompt"));
  assert.ok(!root.classList.contains("is-task"));
  assert.ok(root.classList.contains("is-running"));
  assert.equal(root.querySelector<HTMLElement>(".ctxpill-meta")!.textContent, "");
  pill.destroy();
});

test("task mode: step text owns the strip, dots, mono timer", () => {
  const { pill, host } = makePill();
  pill.update(
    snapshot({
      running: true,
      plan: {
        title: "GAS 冷却检查",
        steps: [
          { title: "定位", state: "done" },
          { title: "衰减曲线", state: "current" },
          { title: "补测试", state: "todo" },
        ],
      },
    }),
  );
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  assert.ok(root.classList.contains("is-task"));
  const text = root.querySelector<HTMLElement>(".ctxpill-text")!;
  // v2 shape: space goes to the current step — no plan title composite.
  assert.equal(text.textContent, "衰减曲线");
  assert.equal(text.querySelector("b"), null);
  // Full label still rides the native tooltip.
  assert.match(root.title, /GAS 冷却检查/);
  const dots = root.querySelectorAll(".ctxpill-steps i");
  assert.equal(dots.length, 3);
  assert.equal(dots[0]!.className, "done");
  assert.equal(dots[1]!.className, "cur");
  assert.equal(dots[2]!.className, "");
  // Progress count retired from the meta (dots carry it) — timer only.
  assert.equal(root.querySelector<HTMLElement>(".ctxpill-meta")!.textContent, "0:00");
  pill.destroy();
});

test("prompt on screen auto-folds to the 3-dot strip; click expands (peek)", () => {
  const { pill, host } = makePill();
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;

  pill.update(snapshot({ lastUserText: "prompt text" }));
  assert.ok(
    !root.classList.contains("is-folded"),
    "off-screen prompt keeps the pill expanded",
  );

  // Prompt scrolls into view → auto-fold: 6 dots, no icons, no button.
  pill.update(snapshot({ lastUserText: "prompt text", promptVisible: true }));
  assert.ok(root.classList.contains("is-folded"));
  const dots = root.querySelector<HTMLElement>(".ctxpill-dots")!;
  assert.equal(dots.querySelectorAll("i").length, 3, "three solid dots");
  assert.equal(
    root.querySelector(".ctxpill-fold") !== null,
    true,
    "chevron stays in the DOM — CSS hides it folded (whole-strip clicks)",
  );
  assert.equal(root.getAttribute("role"), "button");
  assert.equal(root.getAttribute("tabindex"), "0");

  // Whole-strip click expands while the prompt stays on screen (peek).
  root.click();
  assert.ok(!root.classList.contains("is-folded"));
  assert.equal(root.getAttribute("role"), null);

  // The next visibility transition re-syncs to auto (and clears the peek):
  // out of view stays expanded, back in view folds again.
  pill.update(snapshot({ lastUserText: "prompt text", promptVisible: false }));
  assert.ok(!root.classList.contains("is-folded"));
  pill.update(snapshot({ lastUserText: "prompt text", promptVisible: true }));
  assert.ok(root.classList.contains("is-folded"));
  pill.destroy();
});

test("chevron manually folds while the prompt is off screen; auto re-syncs later", () => {
  const { pill, host } = makePill();
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(snapshot({ lastUserText: "x", promptVisible: false }));
  assert.ok(!root.classList.contains("is-folded"));

  // Manual fold via the chevron persists across renders with no transition.
  root.querySelector<HTMLElement>(".ctxpill-fold")!.click();
  assert.ok(root.classList.contains("is-folded"));
  pill.update(snapshot({ lastUserText: "x", promptVisible: false }));
  assert.ok(root.classList.contains("is-folded"), "no transition → stays folded");

  // Prompt scrolls into view → auto fold (no visible change), override cleared.
  pill.update(snapshot({ lastUserText: "x", promptVisible: true }));
  assert.ok(root.classList.contains("is-folded"));
  // …and back out → auto expands again (manual override was reset).
  pill.update(snapshot({ lastUserText: "x", promptVisible: false }));
  assert.ok(!root.classList.contains("is-folded"));
  pill.destroy();
});

test("keyboard: Enter on the folded strip expands it too", () => {
  const { pill, host } = makePill();
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(snapshot({ lastUserText: "k", promptVisible: true }));
  assert.ok(root.classList.contains("is-folded"));
  // linkedom has no KeyboardEvent — synthesize one with a key property.
  const keydown = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(keydown, "key", { value: "Enter" });
  root.dispatchEvent(keydown);
  assert.ok(!root.classList.contains("is-folded"));
  pill.destroy();
});

test("folded task card hides the meta — the dots strip is content-free", () => {
  const { pill, host } = makePill();
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(
    snapshot({
      running: true,
      promptVisible: true,
      plan: {
        title: "T",
        steps: [
          { title: "a", state: "done" },
          { title: "b", state: "current" },
        ],
      },
    }),
  );
  assert.ok(root.classList.contains("is-task"));
  // Running stays legible while folded: spinner rides the dots strip (CSS).
  assert.ok(root.classList.contains("is-running"));
  assert.ok(root.querySelector(".ctxpill-spin") !== null);
  assert.equal(root.querySelector<HTMLElement>(".ctxpill-meta")!.textContent, "");
  // Expanded again (prompt off screen) the count + timer come back.
  pill.update(
    snapshot({
      running: true,
      promptVisible: false,
      plan: {
        title: "T",
        steps: [
          { title: "a", state: "done" },
          { title: "b", state: "current" },
        ],
      },
    }),
  );
  assert.equal(
    root.querySelector<HTMLElement>(".ctxpill-meta")!.textContent,
    "0:00",
  );
  pill.destroy();
});

test("folded tooltip echoes the anchor prompt — even while a task card owns the strip", () => {
  const { pill, host } = makePill();
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;

  // Idle, prompt on screen → folded; tooltip = the visible prompt's text.
  pill.update(snapshot({ lastUserText: "visible prompt text", promptVisible: true }));
  assert.ok(root.classList.contains("is-folded"));
  assert.equal(root.title, "visible prompt text");

  // Running + plan → task card owns the strip, but the folded tooltip still
  // carries the anchored prompt (was the "plan — step" composite).
  pill.update(
    snapshot({
      running: true,
      promptVisible: true,
      lastUserText: "prompt being read",
      plan: {
        title: "T",
        steps: [{ title: "a", state: "current" }],
      },
    }),
  );
  assert.ok(root.classList.contains("is-task"));
  assert.ok(root.classList.contains("is-folded"));
  assert.equal(root.title, "prompt being read");

  // Expanded task card keeps its own composite tooltip (visible content).
  pill.update(
    snapshot({
      running: true,
      promptVisible: false,
      lastUserText: "prompt being read",
      plan: {
        title: "T",
        steps: [{ title: "a", state: "current" }],
      },
    }),
  );
  assert.ok(!root.classList.contains("is-folded"));
  assert.equal(root.title, "T — a");
  pill.destroy();
});

test("folded files-only prompt falls back to attachment names in the tooltip", () => {
  const { pill, host } = makePill();
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(
    snapshot({
      lastUserText: "",
      lastUserFiles: ["shot-a.png", "shot-b.png"],
      promptVisible: true,
    }),
  );
  assert.ok(root.classList.contains("is-folded"));
  assert.equal(root.title, "shot-a.png\nshot-b.png");
  pill.destroy();
});

test("reset clears the pill (session switch)", () => {
  const { pill, host } = makePill();
  pill.update(snapshot({ lastUserText: "旧会话" }));
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  assert.equal(root.hidden, false);
  pill.reset();
  assert.ok(root.hidden);
  pill.destroy();
});

test("destroy removes the root from the host", () => {
  const { pill, host } = makePill();
  pill.update(snapshot({ running: true, lastUserText: "x" }));
  pill.destroy();
  assert.equal(host.querySelectorAll(".devmode-ctxpill").length, 0);
});

test("width tween is skipped without a layout engine (linkedom)", () => {
  const { pill, host } = makePill();
  pill.update(snapshot({ lastUserText: "宽度测量" }));
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  // offsetWidth is 0 in linkedom — the pill must stay width:auto, not "0px".
  assert.notEqual(root.style.width, "0px");
  pill.destroy();
});

test("editor status pill: spinner + progress text, gated by chat collapse", () => {
  const pill = new ContextPillController({
    computeMode: computeEditorStatusMode,
  });
  const host = document.createElement("div");
  pill.mount(host);
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;

  // Running + progress → visible status strip.
  pill.update(snapshot({ running: true, progressText: "read_file main.ts" }));
  assert.equal(root.hidden, false);
  assert.ok(root.classList.contains("is-status"));
  assert.ok(root.classList.contains("is-running"));
  assert.equal(
    root.querySelector<HTMLElement>(".ctxpill-text")!.textContent,
    "read_file main.ts",
  );

  // Gate closed (chat pane expanded) → hidden even with content.
  pill.setGate(false);
  assert.ok(root.hidden);
  pill.setGate(true);
  assert.equal(root.hidden, false);

  // Idle → hidden again.
  pill.update(snapshot({ running: false, progressText: "read_file main.ts" }));
  assert.ok(root.hidden);
  pill.destroy();
});

test("foldable:false (editor strip): never folds, click does nothing", () => {
  const pill = new ContextPillController({
    computeMode: computeEditorStatusMode,
    foldable: false,
  });
  const host = document.createElement("div");
  pill.mount(host);
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;

  assert.ok(root.classList.contains("no-fold"));
  assert.equal(root.querySelector(".ctxpill-fold"), null);
  assert.equal(root.getAttribute("role"), null);

  pill.update(
    snapshot({
      running: true,
      progressText: "read_file main.ts",
      promptVisible: true,
    }),
  );
  assert.equal(
    root.querySelector<HTMLElement>(".ctxpill-text")!.textContent,
    "read_file main.ts",
  );
  assert.ok(
    !root.classList.contains("is-folded"),
    "prompt visibility never folds the editor strip",
  );
  root.click();
  assert.ok(!root.classList.contains("is-folded"));
  pill.destroy();
});

test("file badge: count chip beside text, tooltip lists names", () => {
  const { pill, host } = makePill();
  pill.update(
    snapshot({
      lastUserText: "对比两份配置",
      lastUserFiles: ["relay-notes.md", "servers.md"],
    }),
  );
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  const badge = root.querySelector<HTMLElement>(".ctxpill-files")!;
  assert.equal(badge.hidden, false);
  assert.ok(!badge.classList.contains("is-solo"), "text present → count chip");
  assert.equal(
    badge.textContent,
    "2",
    "badge label is the attachment count",
  );
  assert.equal(
    badge.getAttribute("title"),
    "relay-notes.md\nservers.md",
  );
  assert.ok(badge.querySelector("svg"), "paperclip icon present");
  pill.destroy();
});

test("file badge: files-only prompt widens into the echo", () => {
  const { pill, host } = makePill();
  pill.update(
    snapshot({ lastUserFiles: ["report-final.pdf", "data.csv"] }),
  );
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  assert.equal(root.hidden, false, "files-only no longer hides the pill");
  const badge = root.querySelector<HTMLElement>(".ctxpill-files")!;
  assert.ok(badge.classList.contains("is-solo"));
  assert.equal(badge.textContent, "2 files");
  // Empty text still renders (no stray content).
  assert.equal(
    root.querySelector<HTMLElement>(".ctxpill-text")!.textContent,
    "",
  );
  pill.destroy();
});

test("file badge: hidden without attachments and in task mode", () => {
  const { pill, host } = makePill();
  pill.update(snapshot({ lastUserText: "纯文本" }));
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  const badge = root.querySelector<HTMLElement>(".ctxpill-files")!;
  assert.ok(badge.hidden, "no attachments → badge hidden");
  assert.equal(badge.getAttribute("title"), null);

  // Task mode (running + plan) never carries the badge.
  pill.update(
    snapshot({
      running: true,
      lastUserFiles: ["a.md"],
      plan: {
        title: "迁移",
        steps: [{ title: "s1", state: "current" }],
      },
    }),
  );
  assert.ok(root.classList.contains("is-task"));
  assert.ok(badge.hidden, "task mode drops the badge");
  pill.destroy();
});

// ---- doneFade (editor status strip): Done dwell + variant-B leave ----

function makeStatusPill() {
  const pill = new ContextPillController({
    computeMode: computeEditorStatusMode,
    foldable: false,
    doneFade: true,
  });
  const host = document.createElement("div");
  pill.mount(host);
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  return { pill, root };
}

function fireAnimationEnd(root: HTMLElement): void {
  // linkedom has no AnimationEvent — synthesize with an animationName.
  const end = new dom.window.Event("animationend", { bubbles: true });
  Object.defineProperty(end, "animationName", {
    value: "devmode-ctxpill-leave",
  });
  root.dispatchEvent(end);
}

test("doneFade: turn end dwells on Done, then leaves via the animation", () => {
  const { pill, root } = makeStatusPill();
  mock.timers.enable({ apis: ["setTimeout"] });
  pill.update(snapshot({ running: true, progressText: "Editing a.ts" }));
  assert.ok(!root.hidden && root.classList.contains("is-status"));

  pill.update(snapshot({ running: false, progressText: "" }));
  assert.ok(!root.hidden, "dwell keeps the strip visible");
  assert.ok(root.classList.contains("is-done"), "done state is set");
  assert.ok(!root.classList.contains("is-leaving"), "still dwelling");
  assert.ok(root.querySelector(".ctxpill-check") !== null, "check badge exists");
  assert.equal(
    root.querySelector<HTMLElement>(".ctxpill-text")!.textContent,
    "Done",
  );

  mock.timers.tick(3000);
  assert.ok(root.classList.contains("is-leaving"), "3s → leave animation");

  fireAnimationEnd(root);
  assert.ok(root.hidden, "animationend hides the strip");
  assert.ok(!root.classList.contains("is-done"));
  mock.timers.reset();
  pill.destroy();
});

test("doneFade: a new turn during the dwell cancels it cleanly", () => {
  const { pill, root } = makeStatusPill();
  mock.timers.enable({ apis: ["setTimeout"] });
  pill.update(snapshot({ running: true, progressText: "step 1" }));
  pill.update(snapshot({ running: false, progressText: "" }));
  assert.ok(root.classList.contains("is-done"));

  pill.update(snapshot({ running: true, progressText: "step 2" }));
  assert.ok(!root.classList.contains("is-done"), "dwell cancelled");
  assert.ok(!root.classList.contains("is-leaving"));
  assert.equal(
    root.querySelector<HTMLElement>(".ctxpill-text")!.textContent,
    "step 2",
  );
  // The stale dwell timer must not fire into the new turn.
  mock.timers.tick(4000);
  assert.ok(!root.hidden && !root.classList.contains("is-leaving"));
  mock.timers.reset();
  pill.destroy();
});

test("doneFade: gate-off (chat pane expanded) yanks the strip immediately", () => {
  const { pill, root } = makeStatusPill();
  mock.timers.enable({ apis: ["setTimeout"] });
  pill.update(snapshot({ running: true, progressText: "work" }));
  pill.update(snapshot({ running: false, progressText: "" }));
  assert.ok(root.classList.contains("is-done"));

  pill.setGate(false);
  assert.ok(root.hidden, "gate-off hides without lingering on Done");
  assert.ok(!root.classList.contains("is-done"));
  mock.timers.reset();
  pill.destroy();
});

test("doneFade: idle re-renders after turn end cannot yank the dwell", () => {
  const { pill, root } = makeStatusPill();
  mock.timers.enable({ apis: ["setTimeout"] });
  pill.update(snapshot({ running: true, progressText: "work" }));
  pill.update(snapshot({ running: false, progressText: "" }));
  assert.ok(root.classList.contains("is-done"));

  // Trailing idle frames (progress clears, prompt visibility flips, …).
  pill.update(snapshot({ running: false, progressText: "", promptVisible: true }));
  pill.update(snapshot({ running: false, progressText: "" }));
  assert.ok(!root.hidden, "dwell survives trailing idle snapshots");
  assert.ok(root.classList.contains("is-done"));
  assert.equal(
    root.querySelector<HTMLElement>(".ctxpill-text")!.textContent,
    "Done",
  );

  mock.timers.tick(3000);
  assert.ok(root.classList.contains("is-leaving"));
  fireAnimationEnd(root);
  assert.ok(root.hidden);
  mock.timers.reset();
  pill.destroy();
});

test("doneFade: finished leave strips is-leaving so the next turn is visible", () => {
  const { pill, root } = makeStatusPill();
  mock.timers.enable({ apis: ["setTimeout"] });
  pill.update(snapshot({ running: true, progressText: "work" }));
  pill.update(snapshot({ running: false, progressText: "" }));
  mock.timers.tick(3000);
  assert.ok(root.classList.contains("is-leaving"));
  fireAnimationEnd(root);
  assert.ok(root.hidden);
  // A stale `animation … forwards` would re-play on the next display flip
  // and pin opacity at 0 — the second turn's strip must start clean.
  assert.ok(!root.classList.contains("is-leaving"), "leave class stripped");

  pill.update(snapshot({ running: true, progressText: "round two" }));
  assert.ok(!root.hidden, "second turn shows the strip");
  assert.ok(!root.classList.contains("is-leaving"));
  assert.ok(!root.classList.contains("is-done"));
  mock.timers.reset();
  pill.destroy();
});

// ---- notice (command feedback): transient status line over the pill ----

function pillText(host: HTMLElement): string {
  return host.querySelector<HTMLElement>(".ctxpill-text")!.textContent ?? "";
}

test("notice: overrides the strip, then restores the snapshot mode", () => {
  const { pill, host } = makePill();
  mock.timers.enable({ apis: ["setTimeout"] });
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(snapshot({ lastUserText: "Keep this prompt" }));
  assert.ok(root.classList.contains("is-prompt"));

  pill.showNotice("build finished", 600);
  assert.ok(!root.hidden, "notice is visible");
  assert.ok(root.classList.contains("is-notice"));
  assert.ok(root.classList.contains("is-status"));
  assert.ok(!root.classList.contains("is-prompt"));
  assert.equal(pillText(host), "build finished");
  assert.equal(root.title, "build finished", "tooltip keeps the full text");

  mock.timers.tick(600);
  assert.ok(!root.classList.contains("is-notice"), "notice class cleared");
  assert.ok(root.classList.contains("is-prompt"), "prompt echo restored");
  assert.equal(pillText(host), "Keep this prompt");
  mock.timers.reset();
  pill.destroy();
});

test("notice: spinner flag drives is-running without a running turn", () => {
  const { pill, host } = makePill();
  mock.timers.enable({ apis: ["setTimeout"] });
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(snapshot({ lastUserText: "p" }));

  pill.showNotice("Optimising prompt…", 600, { spinner: true });
  assert.ok(root.classList.contains("is-running"), "in-flight notice spins");

  mock.timers.tick(600);
  assert.ok(
    !root.classList.contains("is-running"),
    "restored idle prompt has no spinner",
  );

  pill.showNotice("Prompt optimised", 600);
  assert.ok(!root.classList.contains("is-running"), "plain notice never spins");
  assert.equal(pillText(host), "Prompt optimised");
  mock.timers.reset();
  pill.destroy();
});

test("notice: a folded strip force-expands, then restores the fold", () => {
  const { pill, host } = makePill();
  mock.timers.enable({ apis: ["setTimeout"] });
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(snapshot({ lastUserText: "folded prompt", promptVisible: true }));
  assert.ok(
    root.classList.contains("is-folded"),
    "auto-folded while the prompt is visible",
  );

  pill.showNotice("Context cleared — new conversation", 600);
  assert.ok(!root.classList.contains("is-folded"), "notice forces the strip open");
  assert.ok(root.classList.contains("is-notice"));

  mock.timers.tick(600);
  assert.ok(
    root.classList.contains("is-folded"),
    "fold state restored after expiry",
  );
  mock.timers.reset();
  pill.destroy();
});

test("notice: a prompt-visibility transition during the notice replays on expiry", () => {
  const { pill, host } = makePill();
  mock.timers.enable({ apis: ["setTimeout"] });
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(
    snapshot({ lastUserText: "scroll me away", promptVisible: false }),
  );
  assert.ok(!root.classList.contains("is-folded"));

  pill.showNotice("build started", 600);
  // Prompt scrolled on-screen mid-notice — swallowed while it owns the strip.
  pill.update(
    snapshot({ lastUserText: "scroll me away", promptVisible: true }),
  );
  assert.ok(root.classList.contains("is-notice"));

  mock.timers.tick(600);
  assert.ok(
    root.classList.contains("is-folded"),
    "swallowed visibility edge replays at expiry",
  );
  mock.timers.reset();
  pill.destroy();
});

test("notice: reset clears an in-flight notice", () => {
  const { pill, host } = makePill();
  mock.timers.enable({ apis: ["setTimeout"] });
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(snapshot({ lastUserText: "p" }));
  pill.showNotice("build started", 600);
  assert.ok(root.classList.contains("is-notice"));

  pill.reset();
  assert.ok(root.hidden, "reset hides the strip");
  assert.ok(!root.classList.contains("is-notice"));
  // The stale notice timer must not resurrect anything after reset.
  mock.timers.tick(5000);
  assert.ok(root.hidden);
  mock.timers.reset();
  pill.destroy();
});

test("notice: a second notice replaces the first and its timer", () => {
  const { pill, host } = makePill();
  mock.timers.enable({ apis: ["setTimeout"] });
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(snapshot({ lastUserText: "p" }));

  pill.showNotice("first notice", 600);
  pill.showNotice("second notice", 600);
  assert.equal(pillText(host), "second notice");
  mock.timers.tick(600);
  assert.ok(!root.classList.contains("is-notice"), "latest timer wins");
  assert.equal(pillText(host), "p");
  mock.timers.reset();
  pill.destroy();
});

test("notice: snapshots during a notice are swallowed; expiry recomputes", () => {
  const { pill, root } = makeStatusPill();
  mock.timers.enable({ apis: ["setTimeout"] });
  pill.update(snapshot({ running: true, progressText: "step 1" }));
  assert.equal(root.querySelector<HTMLElement>(".ctxpill-text")!.textContent, "step 1");

  pill.showNotice("build started", 600);
  pill.update(snapshot({ running: true, progressText: "step 2" }));
  assert.equal(
    root.querySelector<HTMLElement>(".ctxpill-text")!.textContent,
    "build started",
    "mid-notice snapshot is swallowed",
  );

  mock.timers.tick(600);
  assert.equal(
    root.querySelector<HTMLElement>(".ctxpill-text")!.textContent,
    "step 2",
    "expiry recomputes from the latest snapshot",
  );
  assert.ok(root.classList.contains("is-running"), "running state restored");
  mock.timers.reset();
  pill.destroy();
});

test("notice: gate-off hides the mirrored notice; gate-on brings it back", () => {
  const { pill, root } = makeStatusPill();
  mock.timers.enable({ apis: ["setTimeout"] });
  pill.setGate(false); // chat pane expanded → editor strip gated off
  pill.showNotice("build started", 600);
  assert.ok(root.hidden, "gated strip stays hidden");

  pill.setGate(true); // chat collapsed mid-notice
  assert.ok(!root.hidden, "notice survives the gate flip");
  assert.ok(root.classList.contains("is-notice"));
  mock.timers.reset();
  pill.destroy();
});

test("notice: empty text is ignored", () => {
  const { pill, host } = makePill();
  mock.timers.enable({ apis: ["setTimeout"] });
  const root = host.querySelector<HTMLElement>(".devmode-ctxpill")!;
  pill.update(snapshot({ lastUserText: "p" }));
  pill.showNotice("   ");
  assert.ok(!root.classList.contains("is-notice"));
  assert.ok(root.classList.contains("is-prompt"));
  mock.timers.reset();
  pill.destroy();
});
