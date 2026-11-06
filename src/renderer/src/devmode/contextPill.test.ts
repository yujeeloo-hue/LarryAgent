/**
 * Top context pill — pure mode-selection logic (renderer → pill contract).
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  computeContextPillMode,
  computeEditorStatusMode,
  morphStaggerStep,
  pillFilesFromParts,
  pillStepState,
  pillTextFromParts,
  sameContextPillSnapshot,
  MORPH_STAGGER_BUDGET_MS,
  type ContextPillSnapshot,
} from "./contextPill.js";

function baseSnapshot(
  overrides: Partial<ContextPillSnapshot> = {},
): ContextPillSnapshot {
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

test("pillStepState maps session statuses onto pill dot states", () => {
  assert.equal(pillStepState("completed"), "done");
  assert.equal(pillStepState("in_progress"), "current");
  assert.equal(pillStepState("pending"), "todo");
  assert.equal(pillStepState("cancelled"), "todo");
});

test("idle + latest prompt → prompt mode", () => {
  const mode = computeContextPillMode(
    baseSnapshot({ lastUserText: "帮我检查 GAS 冷却逻辑" }),
  );
  assert.deepEqual(mode, {
    kind: "prompt",
    text: "帮我检查 GAS 冷却逻辑",
    files: null,
  });
});

test("idle + nothing yet → hidden", () => {
  assert.equal(computeContextPillMode(baseSnapshot()).kind, "hidden");
  // Blank prompt text collapses to hidden too.
  assert.equal(
    computeContextPillMode(baseSnapshot({ lastUserText: "   " })).kind,
    "hidden",
  );
});

test("running + active plan → task card with steps", () => {
  const mode = computeContextPillMode({
    running: true,
    lastUserText: "随便",
    lastUserFiles: null,
    plan: {
      title: "GAS 冷却检查",
      steps: [
        { title: "定位冷却计算", state: "done" },
        { title: "检查衰减曲线", state: "current" },
        { title: "补测试", state: "todo" },
      ],
    },
  });
  assert.equal(mode.kind, "task");
  if (mode.kind !== "task") return;
  assert.equal(mode.title, "GAS 冷却检查");
  assert.equal(mode.stepTitle, "检查衰减曲线");
  assert.deepEqual(mode.steps, ["done", "current", "todo"]);
  assert.equal(mode.done, 1);
});

test("running without a plan → latest prompt, not progress text", () => {
  const mode = computeContextPillMode(
    baseSnapshot({ running: true, lastUserText: "修复编辑器焦点" }),
  );
  assert.deepEqual(mode, { kind: "prompt", text: "修复编辑器焦点", files: null });
  // Nothing to show at all → hidden even while running.
  assert.equal(
    computeContextPillMode(baseSnapshot({ running: true })).kind,
    "hidden",
  );
});

test("plan with no current step falls back to the last step title", () => {
  const mode = computeContextPillMode({
    running: true,
    lastUserText: null,
    lastUserFiles: null,
    progressText: "",
    plan: {
      title: "迁移构建脚本",
      steps: [
        { title: "A", state: "done" },
        { title: "B", state: "done" },
      ],
    },
  });
  if (mode.kind !== "task") throw new Error("expected task");
  assert.equal(mode.stepTitle, "B");
  assert.equal(mode.done, 2);
});

test("editor status mode: spinner text only while running", () => {
  // Running + progress text → status strip content.
  assert.deepEqual(
    computeEditorStatusMode(
      baseSnapshot({ running: true, progressText: "patch EditorArea.ts" }),
    ),
    { kind: "status", text: "patch EditorArea.ts" },
  );
  // Idle → hidden (the chat pill owns idle content).
  assert.equal(
    computeEditorStatusMode(
      baseSnapshot({ running: false, progressText: "patch EditorArea.ts" }),
    ).kind,
    "hidden",
  );
  // Running but nothing to say yet → hidden.
  assert.equal(
    computeEditorStatusMode(baseSnapshot({ running: true })).kind,
    "hidden",
  );
  // Prompt/plan never leak into the status strip.
  assert.equal(
    computeEditorStatusMode(
      baseSnapshot({
        running: true,
        lastUserText: "检查 GAS",
        plan: { title: "T", steps: [{ title: "s", state: "done" }] },
      }),
    ).kind,
    "hidden",
  );
});

test("sameContextPillSnapshot compares fields and plan steps", () => {
  const a: ContextPillSnapshot = {
    running: true,
    lastUserText: "x",
    lastUserFiles: null,
    progressText: "",
    promptVisible: false,
    plan: { title: "t", steps: [{ title: "s1", state: "done" }] },
  };
  assert.equal(sameContextPillSnapshot(null, a), false);
  assert.equal(sameContextPillSnapshot(a, { ...a }), true);
  assert.equal(
    sameContextPillSnapshot(a, { ...a, progressText: "z" }),
    false,
  );
  assert.equal(
    sameContextPillSnapshot(a, {
      ...a,
      running: false,
    }),
    false,
  );
  assert.equal(
    sameContextPillSnapshot(a, {
      ...a,
      plan: { title: "t", steps: [{ title: "s1", state: "current" }] },
    }),
    false,
  );
  assert.equal(
    sameContextPillSnapshot(a, { ...a, promptVisible: true }),
    false,
  );
  assert.equal(sameContextPillSnapshot(a, { ...a, plan: null }), false);
  // Both null plans → equal.
  const b: ContextPillSnapshot = {
    running: false,
    lastUserText: null,
    lastUserFiles: null,
    progressText: "",
    promptVisible: false,
    plan: null,
  };
  assert.equal(sameContextPillSnapshot(b, { ...b }), true);
});

test("pillTextFromParts joins text parts and collapses whitespace", () => {
  assert.equal(
    pillTextFromParts([
      { type: "text", text: "  帮我\n看看   这个 " },
      { type: "tool_call", id: "tc1" },
      { type: "text", text: "文件" },
    ]),
    "帮我 看看 这个 文件",
  );
  assert.equal(
    pillTextFromParts([{ type: "attachment", path: "a.png" }]),
    null,
  );
  assert.equal(pillTextFromParts([]), null);
});

test("prompt with files → prompt mode carrying the badge names", () => {
  const mode = computeContextPillMode(
    baseSnapshot({
      lastUserText: "对比两份配置",
      lastUserFiles: ["relay-notes.md", "servers.md", "deploy.sh"],
    }),
  );
  assert.deepEqual(mode, {
    kind: "prompt",
    text: "对比两份配置",
    files: ["relay-notes.md", "servers.md", "deploy.sh"],
  });
});

test("files-only prompt → empty text, badge becomes the echo", () => {
  // The case that used to vanish entirely (pillTextFromParts → null).
  const mode = computeContextPillMode(
    baseSnapshot({ lastUserFiles: ["report.pdf", "data.csv"] }),
  );
  assert.deepEqual(mode, {
    kind: "prompt",
    text: "",
    files: ["report.pdf", "data.csv"],
  });
  assert.notEqual(mode.kind, "hidden");
});

test("empty files array is treated as no attachments", () => {
  assert.equal(
    computeContextPillMode(baseSnapshot({ lastUserFiles: [] })).kind,
    "hidden",
  );
});

test("pillFilesFromParts collects attachment names, URI basename fallback", () => {
  assert.deepEqual(
    pillFilesFromParts([
      { type: "text", text: "看看" },
      { type: "attachment", name: "shot.png", uri: "file:///tmp/x.png" },
      { type: "attachment", uri: "https://x.test/a/b/report.pdf?sig=1" },
    ]),
    ["shot.png", "report.pdf"],
  );
  // Non-attachment parts and blank results never make the badge.
  assert.equal(
    pillFilesFromParts([{ type: "text", text: "纯文本" }]),
    null,
  );
  assert.equal(pillFilesFromParts([]), null);
});

test("sameContextPillSnapshot compares the file list", () => {
  const a: ContextPillSnapshot = {
    running: false,
    lastUserText: "x",
    lastUserFiles: ["a.md", "b.md"],
    progressText: "",
    promptVisible: false,
    plan: null,
  };
  assert.equal(sameContextPillSnapshot(a, { ...a }), true);
  assert.equal(
    sameContextPillSnapshot(a, { ...a, lastUserFiles: ["a.md"] }),
    false,
  );
  assert.equal(
    sameContextPillSnapshot(a, {
      ...a,
      lastUserFiles: ["a.md", "c.md"],
    }),
    false,
  );
  assert.equal(sameContextPillSnapshot(a, { ...a, lastUserFiles: null }), false);
});

test("morphStaggerStep keeps the per-letter rise inside the budget", () => {
  // Short lines keep the approved 14ms/char wave untouched.
  assert.equal(morphStaggerStep(1), 14);
  assert.equal(morphStaggerStep(2), 14);
  assert.equal(morphStaggerStep(12), 14);
  // Long lines scale the step down — the tail must commit within ~160ms
  // (the fixed 14ms left a 120-char line's tail invisible for 1.7s).
  assert.ok(morphStaggerStep(80) < 14);
  assert.ok(morphStaggerStep(80) > 0);
  for (let n = 2; n <= 200; n += 1) {
    const last = morphStaggerStep(n) * (n - 1);
    assert.ok(
      last <= MORPH_STAGGER_BUDGET_MS + 1e-9,
      `n=${n} tail delay ${last}ms exceeds the budget`,
    );
  }
});
