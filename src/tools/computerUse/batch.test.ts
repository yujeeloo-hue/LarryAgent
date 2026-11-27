import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { JsonObject, ToolExecuteContext, ToolExecuteResult } from "../types.js";
import { validateToolArguments } from "../validateToolArguments.js";
import { computerBatchHandler, computerMouseHandler, setComputerUseServiceForTests } from "../builtin/computerUse.js";
import { computerBatchDefinition, runComputerBatch } from "./batch.js";
import { configureComputerUseCache } from "./cache.js";
import { ComputerUseService } from "./service.js";
import { WindowAvoidance } from "./windowAvoidance.js";
import type { BatchDesktopState, ComputerUsePlatform, UiElement } from "./types.js";
import type { ComputerUseBackend } from "./worker.js";

const frame = { x: 10, y: 20, width: 600, height: 400 };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/tXcAAAAASUVORK5CYII=", "base64");
const context: ToolExecuteContext = { workspacePath: "/test", fullPermissionsEnabled: false };
const search = { name: "Search", role: "AXTextField" };
let tempDir: string;

before(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "larry-batch-test-"));
  configureComputerUseCache(tempDir);
});
after(async () => {
  configureComputerUseCache(null);
  await rm(tempDir, { recursive: true, force: true });
});

function fixture(platform: ComputerUsePlatform = "macos") {
  const actions: string[] = [];
  const commands: string[] = [];
  const screenCrops: unknown[] = [];
  const state: BatchDesktopState = {
    pid: 31337,
    window: { id: "front", title: "Example", frame },
    modal: false,
  };
  const target: UiElement = {
    name: "Search", role: "AXTextField", frame: { x: 25, y: 40, width: 100, height: 20 },
    center: { x: 75, y: 50 },
  };
  const hits: UiElement[] = [target];
  let truncated = false;
  let occluded = false;
  let onInput = (_name: string): void => {};
  const backend: ComputerUseBackend = {
    platform,
    async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      commands.push(cmd);
      switch (cmd) {
        case "ui.find_app": return { app: { pid: 31337, name: "Fixture", bundle_id: "test.fixture" } } as T;
        case "ui.batch_state":
          return { ...state, ...(typeof args.x === "number" ? { hit_window_id: occluded ? "cover" : state.window?.id } : {}) } as T;
        case "ui.find": return { matches: [...hits], visited: hits.length, truncated } as T;
        case "screens": return { screens: [{ id: 1, is_main: true, x: 0, y: 0, width: 800, height: 600 }] } as T;
        case "key.char_vk": return { vk: 70 } as T;
        case "mouse.position": return { x: 70, y: 50 } as T;
        case "input.sequence": {
          const events = args.events as { t: string; down?: boolean }[];
          const name =
            events.some(e => e.t === "button") ? "click" :
            events.some(e => e.t === "char" && e.down) ? "type" :
            events.some(e => e.t === "vk" && e.down) ? "press" : "move";
          actions.push(name);
          onInput(name);
          return { x: 75, y: 50 } as T;
        }
        case "input.click_at":
          actions.push("click");
          onInput("click");
          return {} as T;
        case "input.activity":
          return {} as T;
        case "screen.capture":
          screenCrops.push(args.region);
          await writeFile(String(args.path), png);
          return { path: args.path, width: frame.width, height: frame.height, rect: frame } as T;
        default:
          throw Error(`Unexpected command ${cmd}`);
      }
    },
  };
  const windows = new WindowAvoidance({ settleMs: 0, idleRestoreMs: 60_000 });
  const service = new ComputerUseService(backend, windows);
  return {
    service, state, target, hits, actions, commands, screenCrops,
    onInput: (callback: (name: string) => void) => { onInput = callback; },
    setOccluded: () => { occluded = true; },
    setTruncated: () => { truncated = true; },
    run: (steps: JsonObject[], extra: Partial<ToolExecuteContext> = {}) =>
      runComputerBatch({ app: "Fixture", steps }, { ...context, ...extra }, service, async () => null),
  };
}

function resultBody(result: ToolExecuteResult) {
  const part = result.content[0];
  assert.equal(part?.type, "text");
  return JSON.parse(part.text);
}

it("clicks, observes focus, types and checks the result in one call with one screenshot for the model", async () => {
  const steps: JsonObject[] = [
    { action: "click", target: search },
    { action: "wait_for", until: "focused", target: search },
    { action: "type", target: search, text: "find it" },
    { action: "wait_for", until: "appears", target: { name: "Search results" } },
  ];
  assert.deepEqual(validateToolArguments({ app: "Fixture", steps }, computerBatchDefinition.parameters), { ok: true });
  const f = fixture();
  f.onInput(action => {
    if (action === "click") f.state.focused = { ...search, protected: false };
    if (action === "type") f.hits.push({ ...f.target, name: "Search results", role: "AXList" });
  });
  let imagesSent = 0;
  const result = await f.run(steps, { uploadReadImage: async () => {
    imagesSent++;
    return { url: "data:image/png;base64,AAAA", key: "" };
  } });
  const body = resultBody(result);
  assert.equal(result.returnCode, ToolReturnCode.Success);
  assert.equal(body.outcome, "completed");
  assert.deepEqual(body.completed.map((step: { step: number }) => step.step), [1, 2, 3, 4]);
  assert.deepEqual(f.actions, ["click", "type"]);
  assert.equal(imagesSent, 1);
  assert.equal(result.content[1]?.type, "attachment");
  assert.equal(result.content[1]?.s3?.url, "data:image/png;base64,AAAA");
  assert.deepEqual(f.screenCrops, [[10, 20, 600, 400]]);
});

it("stops on a changed window or an in-window modal after input and preserves the verified prefix", async () => {
  for (const modal of [false, true]) {
    const f = fixture();
    f.onInput(action => {
      if (action === "press") {
        f.state.modal = modal;
        if (!modal) f.state.window = { id: "unexpected", title: "Example", frame: { ...frame, x: 100 } };
      }
    });
    const result = await f.run([
      { action: "wait_for", until: "appears", target: search },
      { action: "press", keys: ["return"] },
      { action: "press", keys: ["tab"] },
    ]);
    const body = resultBody(result);
    assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
    assert.equal(body.outcome, "unexpected_window");
    assert.equal(body.input_may_have_applied, true);
    assert.deepEqual([body.completed[0].step, body.stopped_at.step, body.skipped[0].step], [1, 2, 3]);
    assert.deepEqual(f.actions, ["press"]);
    assert.deepEqual(f.screenCrops, [[modal ? 10 : 100, 20, 600, 400]]);
  }
});

it("rejects an occluded click before dispatch on either platform", async () => {
  for (const platform of ["macos", "windows"] as const) {
    const f = fixture(platform);
    f.setOccluded();
    const result = await f.run([{ action: "click", target: { name: "Search" } }]);
    assert.equal(resultBody(result).outcome, "unexpected_window");
    assert.equal(resultBody(result).input_may_have_applied, false);
    assert.equal(f.actions.includes("click"), false);
  }
});

it("does not type into the wrong field and skips the remainder on a local check failure", async () => {
  const f = fixture();
  f.state.focused = { name: "Other field", role: "AXTextField", protected: false };
  const result = await f.run([
    { action: "type", target: search, text: "sample" },
    { action: "press", keys: ["return"] },
  ]);
  const body = resultBody(result);
  assert.equal(body.outcome, "check_failed");
  assert.equal(body.input_may_have_applied, false);
  assert.equal(body.skipped[0].step, 2);
  assert.deepEqual(f.actions, []);
});

it("does not treat an incomplete accessibility search as a successful disappearance", async () => {
  const f = fixture();
  f.hits.length = 0;
  f.setTruncated();
  const result = await f.run([{ action: "wait_for", until: "disappears", target: search, timeout_s: 0.25 }]);
  assert.equal(resultBody(result).outcome, "check_failed");
});

it("returns at a private handoff checkpoint and omits any screenshot containing the private prompt", async () => {
  const f = fixture();
  const result = await f.run([
    { action: "press", keys: ["tab"] },
    { action: "handoff", kind: "qr_code", reason: "Scan the login code." },
    { action: "press", keys: ["return"] },
  ]);
  const body = resultBody(result);
  assert.equal(body.outcome, "needs_handoff");
  assert.equal(body.completed.length, 1);
  assert.equal(body.skipped[0].step, 3);
  assert.equal(body.screenshot.status, "omitted");
  assert.deepEqual(f.actions, ["press"]);
  assert.equal(f.screenCrops.length, 0);
});

it("stops before typing into a protected field and keeps its observation private", async () => {
  const f = fixture();
  f.state.focused = { ...search, protected: true, password_present: true };
  const result = await f.run([{ action: "type", target: search, text: "sample" }]);
  const body = resultBody(result);
  assert.equal(body.outcome, "needs_handoff");
  assert.equal(body.screenshot.status, "omitted");
  assert.equal(body.password_present, true);
  assert.match(body.hint, /click the enabled Sign in button once/);
  assert.deepEqual(f.actions, []);
});

it("checks the entire batch before sending input", async () => {
  const f = fixture();
  const result = await f.run([{ action: "press", keys: ["return"] }, { action: "press", keys: ["tab", "return"] }]);
  assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
  assert.deepEqual(f.commands, []);
});

it("ends the batch when a takeover finishes and returns the new view", async () => {
  const f = fixture();
  const result = await runComputerBatch({ app: "Fixture", steps: [
    { action: "wait_for", until: "appears", target: search },
    { action: "press", keys: ["return"] },
  ] }, context, f.service, async () => ({
    outcome: "resumed", via: "screen", waitedMs: 40, shownOnScreen: true,
  }));
  assert.equal(resultBody(result).outcome, "user_took_over");
  assert.equal(resultBody(result).completed.length, 1);
  assert.deepEqual(f.actions, []);
  assert.equal(f.screenCrops.length, 1);
});

it("uses an exclusive desktop operation while the registered batch handler runs", async () => {
  const f = fixture();
  setComputerUseServiceForTests(f.service);
  try {
    const first = computerBatchHandler({ app: "Fixture", steps: [{ action: "press", keys: ["return"] }] }, context);
    const conflicting = await computerMouseHandler({ action: "position" }, context);
    assert.equal(conflicting.returnCode, ToolReturnCode.GenericFailure);
    assert.equal((await first).returnCode, ToolReturnCode.Success);
    assert.equal((await computerMouseHandler({ action: "position" }, context)).returnCode, ToolReturnCode.Success);
  } finally {
    setComputerUseServiceForTests(null);
  }
});
