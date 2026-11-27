import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import {
  computerHandoffHandler,
  computerKeyboardHandler,
  computerMouseHandler,
  setComputerUseServiceForTests,
  setTakeoverDepsForTests,
} from "../builtin/computerUse.js";
import type { ToolExecuteContext, UserAskAnswer, UserAskRequestInput } from "../types.js";
import { configureTipsOverlay, parseTipEvent, type TipEvent, type TipSettled, type TipSpec, type TipsOverlay } from "./cursorOverlay.js";
import {
  buildMirrorAsk,
  buildTipSpec,
  CONFIRM_DEFAULT_TIMEOUT_MS,
  noteHandoffEnded,
  resetHandoffStateForTests,
  runHandoff,
  settledView,
  userHasPointer,
  type HandoffRequest,
} from "./handoff.js";
import { HandoffArgumentError, parseHandoffRequest, type HandoffLookup } from "./handoffRequest.js";
import { ComputerUseService } from "./service.js";
import { configureComputerUseSoundPublisher, type ComputerUseSound } from "./sound.js";
import { TAKEOVER_TITLE } from "./takeover.js";
import type { ComputerUsePlatform } from "./types.js";
import { WindowAvoidance } from "./windowAvoidance.js";
import { ComputerUseError, type ComputerUseBackend } from "./worker.js";

type TipAnswer = { action: "primary" | "secondary"; choice?: number };

function fakeTips(answer?: TipAnswer, available = true) {
  const listeners = new Set<(event: TipEvent) => void>();
  const calls: string[] = [];
  const shown: TipSpec[] = [];
  const settled: TipSettled[] = [];
  const emit = (event: TipEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const tips: TipsOverlay = {
    available,
    showTip(spec) {
      shown.push(spec);
      calls.push("show");
      if (answer) setTimeout(() => emit({ event: "tip.answer", id: spec.id, ...answer }), 5);
    },
    settleTip(_id, view) {
      settled.push(view);
      calls.push("settle");
    },
    hideTip() {
      calls.push("hide");
    },
    pause() {
      calls.push("pause");
    },
    resume() {
      calls.push("resume");
    },
    onTipEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { tips, calls, shown, settled, emit, listenerCount: () => listeners.size };
}

function fakeAsk(answer?: UserAskAnswer | null, delayMs = 5) {
  const requests: UserAskRequestInput[] = [];
  const ask = (input: UserAskRequestInput): Promise<UserAskAnswer | null> => {
    requests.push(input);
    return new Promise((resolve) => {
      input.signal?.addEventListener("abort", () => resolve(null), { once: true });
      if (answer !== undefined) setTimeout(() => resolve(answer), delayMs);
    });
  };
  return { ask, requests };
}

const action: HandoffRequest = { kind: "action", title: "Enter the code", message: "Type the 6-digit code." };

afterEach(() => {
  resetHandoffStateForTests();
  configureTipsOverlay(null);
  setComputerUseServiceForTests(null);
  setTakeoverDepsForTests(null);
});

describe("runHandoff", () => {
  it("plays one chime per reachable handoff, including a conversation-only handoff", async () => {
    const sounds: ComputerUseSound[] = [];
    configureComputerUseSoundPublisher(sound => sounds.push(sound));
    try {
      const mirror = fakeAsk({ selected: "Done", custom: false });
      await runHandoff(action, { tips: fakeTips({ action: "primary" }).tips, ask: mirror.ask });
      assert.deepEqual(sounds, [{ kind: "handoff" }]);
      assert.equal(mirror.requests[0]?.suppressChime, true);
      await runHandoff(action, { tips: fakeTips(undefined, false).tips, ask: mirror.ask });
      assert.deepEqual(sounds, [{ kind: "handoff" }, { kind: "handoff" }]);
      await runHandoff(action, { tips: fakeTips(undefined, false).tips });
      await runHandoff(action, { tips: fakeTips().tips, signal: AbortSignal.abort() });
      assert.equal(sounds.length, 2);
    } finally {
      configureComputerUseSoundPublisher(null);
    }
  });

  it("finishes from the on-screen tip and dismisses the conversation card", async () => {
    const screen = fakeTips({ action: "primary" });
    const mirror = fakeAsk();
    const result = await runHandoff(action, { tips: screen.tips, ask: mirror.ask, createId: () => "h1" });
    assert.equal(result.outcome, "done");
    assert.equal(result.via, "screen");
    assert.equal(result.shownOnScreen, true);
    assert.deepEqual(screen.calls, ["pause", "show", "settle", "resume"]);
    assert.deepEqual(screen.settled, [{ tone: "done", title: "Continuing" }]);
    assert.equal(mirror.requests[0]?.signal?.aborted, true);
    assert.equal(mirror.requests[0]?.keepDesktop, true);
    assert.equal(screen.listenerCount(), 0);
  });

  it("maps a conversation answer onto the choice and settles the tip", async () => {
    const screen = fakeTips();
    const mirror = fakeAsk({ selected: "Billing" } as UserAskAnswer);
    const request: HandoffRequest = {
      kind: "choice",
      title: "Which account?",
      message: "",
      options: [{ label: "Work" }, { label: "Billing", detail: "billing@acme.example" }],
    };
    const result = await runHandoff(request, { tips: screen.tips, ask: mirror.ask });
    assert.deepEqual([result.outcome, result.choice, result.via], ["chosen", "Billing", "conversation"]);
    assert.deepEqual(screen.settled, [{ tone: "done", title: "Going with Billing" }]);
    assert.deepEqual(mirror.requests[0]?.options, ["Work", "Billing", "Skip"]);
  });

  it("continues by itself when the watch condition becomes true", async () => {
    const screen = fakeTips();
    let checks = 0;
    const result = await runHandoff(
      { ...action, watch: { check: async () => ++checks >= 2 } },
      { tips: screen.tips, pollMs: 5 },
    );
    assert.deepEqual([result.outcome, result.via], ["auto", "watch"]);
    assert.equal(screen.shown[0]?.watching, true);
    assert.equal(checks, 2);
  });

  it("times a confirm out to the safe choice", async () => {
    const screen = fakeTips();
    const result = await runHandoff(
      { kind: "confirm", title: "Delete 3 files?", message: "", timeoutMs: 20 },
      { tips: screen.tips },
    );
    assert.deepEqual([result.outcome, result.via], ["timeout", "timer"]);
    assert.deepEqual(screen.settled, [{ tone: "neutral", title: "Timed out · cancelled" }]);
  });

  it("reports unanswered when every channel is gone", async () => {
    const screen = fakeTips();
    const mirror = fakeAsk(null);
    const pending = runHandoff(action, { tips: screen.tips, ask: mirror.ask, createId: () => "h2" });
    screen.emit({ event: "tip.lost", id: "h2" });
    const result = await pending;
    assert.deepEqual([result.outcome, result.via], ["unanswered", "none"]);
    const unreachable = await runHandoff(action, { tips: fakeTips(undefined, false).tips });
    assert.equal(unreachable.outcome, "unanswered");
    assert.equal(unreachable.shownOnScreen, false);
  });

  it("hides the tip without a settled view when the turn is cancelled", async () => {
    const screen = fakeTips();
    const controller = new AbortController();
    const pending = runHandoff(action, { tips: screen.tips, signal: controller.signal });
    controller.abort();
    const result = await pending;
    assert.equal(result.outcome, "cancelled");
    assert.deepEqual(screen.calls, ["pause", "show", "hide", "resume"]);
  });
});

describe("handoff presentation", () => {
  it("keeps the tip spec minimal", () => {
    const spec = buildTipSpec({ kind: "confirm", title: "Move 24 items to Trash?", message: "3.2 GB" }, "t");
    assert.deepEqual(spec, {
      id: "t",
      kind: "confirm",
      title: "Move 24 items to Trash?",
      body: "3.2 GB",
      primary: "Confirm",
      secondary: "Cancel",
      danger: true,
      countdown: CONFIRM_DEFAULT_TIMEOUT_MS / 1000,
      anchor: null,
      place: "corner",
    });
  });

  it("uses one short line for every settled state", () => {
    for (const outcome of ["done", "auto", "chosen", "confirmed", "resumed", "skipped", "declined", "stopped", "timeout"] as const) {
      const view = settledView(action, { outcome, choice: "Work" });
      assert.ok(view && view.title.length <= 24, outcome);
    }
    assert.equal(settledView(action, { outcome: "cancelled" }), null);
  });

  it("mirrors the request into a conversation card that keeps the desktop", () => {
    const ask = buildMirrorAsk({ kind: "takeover", title: TAKEOVER_TITLE, message: "" });
    assert.deepEqual(ask.options, ["Resume", "Stop task"]);
    assert.equal(ask.keepDesktop, true);
    assert.equal(ask.detail, undefined);
  });

  it("parses helper tip events", () => {
    assert.deepEqual(parseTipEvent('{"event":"tip.answer","id":"a","action":"primary","choice":1}'), {
      event: "tip.answer",
      id: "a",
      action: "primary",
      choice: 1,
    });
    assert.equal(parseTipEvent('{"event":"closed"}')?.event, "tip.lost");
    assert.equal(parseTipEvent("not json"), null);
  });
});

describe("pointer takeover detection", () => {
  const now = 100_000;
  const active = { pointerIdleS: 0.3, syntheticAgeS: 30, cursor: { x: 5, y: 5 } };

  it("treats recent real pointer input as the user taking over", () => {
    assert.equal(userHasPointer(active, now, { overJellyBot: false }), true);
  });

  it("ignores idle pointers, our own synthetic input, the post-handoff quiet window and JellyBot windows", () => {
    assert.equal(userHasPointer({ ...active, pointerIdleS: 2 }, now, { overJellyBot: false }), false);
    assert.equal(userHasPointer({ ...active, syntheticAgeS: 0.4 }, now, { overJellyBot: false }), false);
    assert.equal(userHasPointer(active, now, { overJellyBot: true }), false);
    noteHandoffEnded(now - 500);
    assert.equal(userHasPointer(active, now, { overJellyBot: false }), false);
    assert.equal(userHasPointer(active, now + 2_000, { overJellyBot: false }), true);
  });
});

function macBackend(activity: Record<string, unknown> | null, platform: ComputerUsePlatform = "macos") {
  const calls: string[] = [];
  const backend: ComputerUseBackend = {
    platform,
    async request<T>(cmd: string): Promise<T> {
      calls.push(cmd);
      if (cmd === "input.activity") return (activity ?? {}) as T;
      if (cmd === "screens") {
        return { screens: [{ id: 1, is_main: true, x: 0, y: 0, width: 1000, height: 800, scale: 1, pixels_wide: 1000, pixels_high: 800 }] } as T;
      }
      return {} as T;
    },
  };
  return { backend, calls };
}

function useService(backend: ComputerUseBackend): void {
  const windows = new WindowAvoidance({ settleMs: 0, idleRestoreMs: 60_000 });
  windows.configure(null);
  setComputerUseServiceForTests(new ComputerUseService(backend, windows));
}

const baseContext = { workspacePath: "/tmp", fullPermissionsEnabled: true } as ToolExecuteContext;
const userMoving = { pointer_idle_s: 0.2, synthetic_age_s: 40, cursor: { x: 50, y: 50 } };

describe("takeover gate on computer input", () => {
  it("pauses, then skips the action after Resume so the model looks again", async () => {
    const fake = macBackend(userMoving);
    useService(fake.backend);
    const screen = fakeTips({ action: "primary" });
    setTakeoverDepsForTests({ tips: screen.tips });
    const result = await computerMouseHandler({ action: "click", x: 10, y: 10 }, baseContext);
    assert.equal(result.returnCode, 6);
    assert.match((result.content[0] as { text: string }).text, /^Not performed: the user was using the mouse/);
    assert.equal(screen.shown[0]?.title, TAKEOVER_TITLE);
    assert.equal(screen.shown[0]?.place, "corner");
    assert.equal(screen.shown[0]?.spotlight, false);
    assert.equal(fake.calls.includes("input.sequence"), false);
  });

  it("pauses on Windows too, before any input reaches the desktop", async () => {
    const fake = macBackend(userMoving, "windows");
    useService(fake.backend);
    const screen = fakeTips({ action: "primary" });
    setTakeoverDepsForTests({ tips: screen.tips });
    const result = await computerMouseHandler({ action: "click", x: 10, y: 10 }, baseContext);
    assert.equal(result.returnCode, 6);
    assert.equal(screen.shown[0]?.title, TAKEOVER_TITLE);
    assert.equal(fake.calls.includes("input.click_at"), false);
  });

  it("tells the model to stop when the user picks Stop task", async () => {
    useService(macBackend(userMoving).backend);
    setTakeoverDepsForTests({ tips: fakeTips({ action: "secondary" }).tips });
    const result = await computerKeyboardHandler({ action: "press", key: "a" }, baseContext);
    assert.equal(result.returnCode, 6);
    assert.match((result.content[0] as { text: string }).text, /chose Stop task/);
  });

  it("does not pause for subagents, dry runs, read-only actions or an idle pointer", async () => {
    const screen = fakeTips({ action: "primary" });
    setTakeoverDepsForTests({ tips: screen.tips });
    useService(macBackend(userMoving).backend);
    await computerMouseHandler({ action: "position" }, baseContext);
    await computerMouseHandler({ action: "click", x: 1, y: 1, dry_run: true }, baseContext);
    await computerMouseHandler({ action: "move", x: 1, y: 1 }, { ...baseContext, subagentTurn: true });
    useService(macBackend({ ...userMoving, pointer_idle_s: 9 }).backend);
    await computerMouseHandler({ action: "move", x: 1, y: 1 }, baseContext);
    assert.equal(screen.shown.length, 0);
  });
});

describe("computer_handoff tool", () => {
  it("validates arguments", async () => {
    await assert.rejects(parseHandoffRequest({ title: "" }, null), HandoffArgumentError);
    await assert.rejects(parseHandoffRequest({ title: "Pick", kind: "choice", options: ["One"] }, null), /2–6/);
    await assert.rejects(parseHandoffRequest({ title: "Pick", kind: "takeover" }, null), /kind/);
    await assert.rejects(parseHandoffRequest({ title: "Go", wait_for: { until: "appears", app: "Mail" } }, null), /computer use/);
    await assert.rejects(parseHandoffRequest({ title: "Go", sign_in_failed: true }, null), /password handoff only/);
    const parsed = await parseHandoffRequest({ title: "Go", target: { region: [1, 2, 30, 40] }, timeout_s: 1 }, null);
    assert.deepEqual(parsed.request.anchor, { x: 1, y: 2, width: 30, height: 40 });
    assert.equal(parsed.request.timeoutMs, 10_000);
  });

  it("accepts explicit password and QR requests as well as the legacy flags", async () => {
    await assert.rejects(parseHandoffRequest({ title: "Sign in", password: true }, null), /target.app/);
    await assert.rejects(parseHandoffRequest({ title: "Sign in", qr_code: true }, null), /target around the code/);
    const target = { app: "Browser" };
    await assert.rejects(parseHandoffRequest({ title: "Sign in", password: true, qr_code: true, target }, null), /QR handoff/);
    const password = await parseHandoffRequest({ title: "Sign in", password: true, target }, null);
    assert.equal(password.passwordApp, "Browser");
    const qr = await parseHandoffRequest({ title: "Scan", qr_code: true, target: { region: [10, 20, 150, 150] } }, null);
    assert.equal(qr.qrCode, true);
    assert.deepEqual(qr.request.anchor, { x: 10, y: 20, width: 150, height: 150 });
    const region = [20, 30, 160, 40];
    const byRegion = await parseHandoffRequest({ title: "Sign in", kind: "password", target: { ...target, region } }, null);
    assert.equal(byRegion.passwordApp, "Browser");
    assert.deepEqual(byRegion.request.anchor, { x: 20, y: 30, width: 160, height: 40 });
    assert.equal((await parseHandoffRequest({
      title: "Enter the password", target: { ...target, role: "AXSecureTextField" },
    }, null)).passwordApp, "Browser");
    assert.equal((await parseHandoffRequest({ title: "Scan", kind: "qr_code", target: { region } }, null)).qrCode, true);
  });

  it("anchors on a found element and watches it disappear", async () => {
    let present = true;
    const lookup: HandoffLookup = {
      uiFind: async () => ({ matches: present ? [{ role: "AXTextField", name: "Code", frame: { x: 10, y: 20, width: 100, height: 24 } }] : [] }),
      uiWindows: async () => ({ windows: [] }),
    };
    const parsed = await parseHandoffRequest(
      {
        title: "Enter the code",
        target: { app: "Mail", role: "AXTextField" },
        wait_for: { until: "disappears", app: "Mail", role: "AXTextField" },
      },
      lookup,
    );
    assert.deepEqual(parsed.request.anchor, { x: 10, y: 20, width: 100, height: 24 });
    const signal = new AbortController().signal;
    assert.equal(await parsed.request.watch!.check(signal), false);
    present = false;
    assert.equal(await parsed.request.watch!.check(signal), true);
  });

  it("treats a quit app as the element being gone and a missing target as unanchored", async () => {
    const lookup: HandoffLookup = {
      uiFind: async () => {
        throw new ComputerUseError("App not running", "not_found");
      },
      uiWindows: async () => ({ windows: [{ title: "Inbox — Signed in" }] }),
    };
    const parsed = await parseHandoffRequest(
      { title: "Sign in", target: { app: "Mail", name: "Password" }, wait_for: { until: "disappears", app: "Mail", name: "Password" } },
      lookup,
    );
    assert.equal(parsed.anchored, false);
    assert.equal(parsed.targetMissed, true);
    assert.equal(await parsed.request.watch!.check(new AbortController().signal), true);
    const titled = await parseHandoffRequest({ title: "Sign in", wait_for: { until: "title_contains", app: "Mail", text: "signed in" } }, lookup);
    assert.equal(await titled.request.watch!.check(new AbortController().signal), true);
  });

  it("returns the outcome as JSON and resets the iteration budget after a human answer", async () => {
    configureTipsOverlay(fakeTips({ action: "primary", choice: 1 }).tips);
    let resets = 0;
    const result = await computerHandoffHandler(
      { kind: "choice", title: "Which account?", options: [{ label: "Work" }, { label: "Billing" }] },
      { ...baseContext, resetModelIterations: () => void resets++ },
    );
    assert.equal(result.returnCode, 0);
    const body = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(body.outcome, "chosen");
    assert.equal(body.choice, "Billing");
    assert.equal(body.via, "screen");
    assert.equal(resets, 1);
  });

  it("returns a password-filled receipt without exposing the submitted text", async () => {
    const secret = " local fake password ";
    configureTipsOverlay(fakeTips(undefined, false).tips);
    useService({
      platform: "macos",
      async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
        switch (cmd) {
          case "ui.find_app": return { app: { pid: 123, name: "Fixture" } } as T;
          case "ui.prepare_password":
            assert.deepEqual(args, { pid: 123, x: 180, y: 220 });
            return { token: "local-token", destination: { app: "Fixture" } } as T;
          case "ui.fill_password":
            assert.deepEqual(args, { token: "local-token", password: secret });
            return { filled: true } as T;
          default: return {} as T;
        }
      },
    });
    const result = await computerHandoffHandler(
      { title: "Enter the password", kind: "password", target: { app: "Fixture", region: [100, 200, 160, 40] } },
      { ...baseContext, requestUserAsk: async input => {
        assert.equal(input.allowCustom, false);
        assert.ok(await input.desktopPassword?.fill(secret, input.signal));
        return { selected: input.options[0]!, custom: false };
      } },
    );
    const receipt = (result.content[0] as { text: string }).text;
    assert.equal(JSON.parse(receipt).password_filled, true);
    assert.equal(receipt.includes(secret), false);
  });

  it("leaves a populated browser password alone and tells the model to submit and verify", async () => {
    const screen = fakeTips(undefined, true);
    configureTipsOverlay(screen.tips);
    useService({
      platform: "macos",
      async request<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
        if (command === "ui.find_app") return { app: { pid: 123, name: "Browser" } } as T;
        assert.equal(command, "ui.prepare_password");
        assert.deepEqual(args, { pid: 123 });
        return { password_present: true } as T;
      },
    });
    const result = await computerHandoffHandler({
      title: "Sign in", kind: "password", target: { app: "Browser" },
    }, {
      ...baseContext,
      requestUserAsk: async () => assert.fail("A populated password does not need user input"),
      trySavedHandoffPassword: async () => assert.fail("Browser autofill should take priority over the saved login"),
    });
    assert.equal(result.returnCode, 0);
    assert.equal(screen.shown.length, 0);
    const receipt = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(receipt.password_present, true);
    assert.equal(receipt.password_filled, undefined);
    assert.match(receipt.hint, /click the enabled Sign in button once and verify/i);
  });

  it("asks for a replacement after observed sign-in failure without retrying the saved login", async () => {
    configureTipsOverlay(fakeTips(undefined, false).tips);
    useService({
      platform: "macos",
      async request<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
        if (command === "ui.find_app") return { app: { pid: 123, name: "Browser" } } as T;
        if (command === "ui.prepare_password") {
          assert.deepEqual(args, { pid: 123, sign_in_failed: true });
          return {
            token: "private", destination: { app: "Browser" }, login: { origin: "https://example.test", account: "fixture" },
          } as T;
        }
        assert.equal(command, "ui.discard_password");
        return {} as T;
      },
    });
    let prompts = 0;
    const result = await computerHandoffHandler({
      title: "Try a different password", kind: "password", sign_in_failed: true, target: { app: "Browser" },
    }, {
      ...baseContext,
      trySavedHandoffPassword: async () => assert.fail("Do not silently retry a rejected login"),
      requestUserAsk: async input => {
        prompts += 1;
        assert.ok(input.desktopPassword);
        return { selected: "Skip", custom: false };
      },
    });
    assert.equal(prompts, 1);
    const receipt = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(receipt.outcome, "skipped");
  });

  it("defers to the browser if it fills while a saved login is being checked", async () => {
    configureTipsOverlay(fakeTips(undefined, false).tips);
    let preparations = 0;
    useService({
      platform: "macos",
      async request<T>(command: string): Promise<T> {
        if (command === "ui.find_app") return { app: { pid: 123, name: "Browser" } } as T;
        if (command === "ui.prepare_password") {
          preparations += 1;
          return (preparations === 1
            ? { token: "private", destination: { app: "Browser" }, login: { origin: "https://example.test", account: "fixture" } }
            : { password_present: true }) as T;
        }
        assert.equal(command, "ui.discard_password");
        return {} as T;
      },
    });
    const result = await computerHandoffHandler({
      title: "Sign in", kind: "password", target: { app: "Browser" },
    }, {
      ...baseContext,
      trySavedHandoffPassword: async () => "failed",
      requestUserAsk: async () => assert.fail("Do not request a password after the browser has filled it"),
    });
    assert.equal(preparations, 2);
    assert.equal(JSON.parse((result.content[0] as { text: string }).text).password_present, true);
  });

  it("ships the cropped QR to the pending card and removes its temporary file", async () => {
    let capturePath = "";
    const pngHeader = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    configureTipsOverlay(fakeTips(undefined, false).tips);
    useService({
      platform: "macos",
      async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
        assert.equal(cmd, "screen.capture");
        assert.deepEqual(args.region, [20, 30, 160, 160]);
        capturePath = String(args.path);
        await writeFile(capturePath, pngHeader);
        return {} as T;
      },
    });
    const result = await computerHandoffHandler(
      { title: "Scan", qr_code: true, target: { region: [20, 30, 160, 160] } },
      { ...baseContext, requestUserAsk: async input => {
        assert.equal(input.handoffQrPng, pngHeader.toString("base64"));
        return { selected: "Done", custom: false };
      } },
    );
    assert.equal(result.returnCode, 0);
    assert.equal(JSON.stringify(result).includes(pngHeader.toString("base64")), false);
    await assert.rejects(stat(capturePath), { code: "ENOENT" });
  });

  it("uses a matching saved login locally without displaying a prompt or exposing the credential", async () => {
    const screen = fakeTips(undefined, true);
    configureTipsOverlay(screen.tips);
    const fillCalls: Record<string, unknown>[] = [];
    useService({
      platform: "macos",
      async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
        if (cmd === "ui.find_app") return { app: { pid: 123, name: "Browser" } } as T;
        if (cmd === "ui.prepare_password") return {
          token: "local-token", destination: { app: "Browser" },
          login: { origin: "https://example.test", account: "fixture" },
        } as T;
        if (cmd === "ui.fill_password") {
          fillCalls.push(args);
          return { filled: true } as T;
        }
        return {} as T;
      },
    });
    const secret = "synthetic password for the native port";
    const result = await computerHandoffHandler({
      kind: "password", title: "Sign in", target: { app: "Browser" },
    }, {
      ...baseContext,
      requestUserAsk: async () => assert.fail("no manual request for the matched account"),
      trySavedHandoffPassword: async target => {
        assert.deepEqual(target.login, { origin: "https://example.test", account: "fixture" });
        const filled = await target.fill(secret, undefined, { account: "fixture", requireAccountField: true });
        return filled ? "filled" : "failed";
      },
    });
    assert.deepEqual(fillCalls, [{ token: "local-token", password: secret, account: "fixture", require_account_field: true }]);
    assert.equal(screen.shown.length, 0);
    const receipt = (result.content[0] as { text: string }).text;
    assert.equal(JSON.parse(receipt).password_filled, true);
    assert.equal(receipt.includes(secret), false);
    assert.equal(receipt.includes("fixture"), false);
  });

  it("is refused for subagents and when nobody can be reached", async () => {
    const denied = await computerHandoffHandler({ title: "Go" }, { ...baseContext, subagentTurn: true });
    assert.equal(denied.returnCode, 2);
    configureTipsOverlay(fakeTips(undefined, false).tips);
    const unreachable = await computerHandoffHandler({ title: "Go" }, baseContext);
    assert.equal(unreachable.returnCode, 1);
  });
});
