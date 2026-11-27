import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { askJev, jevEndpoint, JevError, type JevClientConfig } from "../../llm/jevClient.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { computerKeyboardHandler, computerMouseHandler, computerScreenHandler, setComputerUseServiceForTests } from "../builtin/computerUse.js";
import type { ToolExecuteContext } from "../types.js";
import { configureComputerUseCache } from "./cache.js";
import { parseHandoffRequest } from "./handoffRequest.js";
import { configureComputerUseJev } from "./jevAccess.js";
import { decideStep, locateTarget, MAX_JEV_ELEMENTS, screenElements } from "./jevScreen.js";
import { runPursue } from "./pursue.js";
import { ComputerUseService } from "./service.js";
import type { Rect, ScreenLine } from "./types.js";
import { WindowAvoidance } from "./windowAvoidance.js";
import type { ComputerUseBackend } from "./worker.js";

const client: JevClientConfig = { baseUrl: "https://jev.test/api", apiKey: "test-key", model: "typesafe/jev-1.14" };
const area: Rect = { x: 0, y: 0, width: 900, height: 600 };
const realFetch = globalThis.fetch;

type Answers = Record<string, unknown>;
type JevBody = { model: string; state: { claim?: string; screen?: { elements: Array<{ id: string; text: string }> } }; questions: Record<string, { type: string }> };

function line(text: string, x: number, y: number): ScreenLine {
  return { text, frame: { x: x - 20, y: y - 8, width: 40, height: 16 }, center: { x, y } };
}

function idFor(body: JevBody, text: string): string {
  const element = body.state.screen?.elements.find((e) => e.text === text);
  assert.ok(element, `element ${text} was sent`);
  return element.id;
}

function choice(choiceId: string, p = 0.96, confidence = 0.95) {
  return { type: "choice", choice: choiceId, probabilities: { [choiceId]: p }, confidence };
}

function noul(p: number) {
  return { type: "noul", noul: p };
}

function stubJev(answer: (body: JevBody, call: number) => Answers | Response): { calls: JevBody[] } {
  const calls: JevBody[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as JevBody;
    calls.push(body);
    const result = answer(body, calls.length);
    if (result instanceof Response) return result;
    return new Response(JSON.stringify({ model: body.model, answers: result, usage: { input_tokens: 10 } }), { status: 200 });
  }) as typeof fetch;
  return { calls };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  configureComputerUseJev(null);
  setComputerUseServiceForTests(null);
});

describe("Jev client", () => {
  it("builds the System One endpoint from common base URLs", () => {
    assert.equal(jevEndpoint("https://openrouter.ai/api"), "https://openrouter.ai/api/v1/systemone");
    assert.equal(jevEndpoint("https://openrouter.ai/api/v1/"), "https://openrouter.ai/api/v1/systemone");
    assert.equal(jevEndpoint("https://api.typesafe.ai/v1/systemone"), "https://api.typesafe.ai/v1/systemone");
  });

  it("keeps only answers that fit the asked options", async () => {
    stubJev(() => ({
      pick: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 }, confidence: 0.8 },
      bogus: { type: "choice", choice: "zzz", probabilities: { zzz: 1 }, confidence: 1 },
      yes: noul(1.4),
    }));
    const result = await askJev(client, {
      state: "s",
      questions: {
        pick: { type: "choice", instructions: "Pick", criteria: { a: "A", b: "B" } },
        bogus: { type: "choice", instructions: "Pick", criteria: { a: "A" } },
        yes: { type: "noul", instructions: "Yes?" },
      },
    });
    assert.equal(result.answers.pick?.choice, "b");
    assert.equal(result.answers.bogus, undefined);
    assert.equal(result.answers.yes?.noul, 1);
  });

  it("retries rate limits but not authentication failures", async () => {
    const limited = stubJev((_body, call) => call === 1
      ? new Response("{}", { status: 429, headers: { "retry-after": "0" } })
      : { yes: noul(0.9) });
    const ok = await askJev(client, { state: "s", questions: { yes: { type: "noul", instructions: "Yes?" } } });
    assert.equal(ok.answers.yes?.noul, 0.9);
    assert.equal(limited.calls.length, 2);

    const denied = stubJev(() => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }));
    await assert.rejects(
      askJev(client, { state: "s", questions: { yes: { type: "noul", instructions: "Yes?" } } }),
      (error: unknown) => error instanceof JevError && error.status === 401 && /bad key/.test(error.message),
    );
    assert.equal(denied.calls.length, 1);
  });
});

describe("OCR elements for Jev", () => {
  it("sends text and coarse positions only, with secrets redacted", () => {
    const table = screenElements([
      line("File", 30, 20),
      line("  ", 100, 100),
      line("key sk-or-v1-abcdef0123456789abcdef", 850, 580),
    ], area);
    assert.deepEqual(table.elements, [
      { id: "e1", text: "File", position: "upper left" },
      { id: "e2", text: "key [redacted]", position: "lower right" },
    ]);
    assert.equal(table.lines.get("e1")?.center.x, 30);
    assert.equal(JSON.stringify(table.elements).includes("850"), false);
  });

  it("caps the candidate list so none still fits in one Choice", () => {
    const lines = Array.from({ length: MAX_JEV_ELEMENTS + 5 }, (_, i) => line(`row ${i}`, 10, i));
    const table = screenElements(lines, area);
    assert.equal(table.elements.length, MAX_JEV_ELEMENTS);
    assert.equal(table.truncated, true);
  });
});

describe("Jev decisions", () => {
  const table = screenElements([line("New Chat", 100, 130), line("Chat", 3000, 400), line("Delete project", 200, 500)], area);

  it("locates a described target and maps it back to the local center", async () => {
    stubJev((body) => ({ target: choice(idFor(body, "New Chat")), present: noul(0.97) }));
    const found = await locateTarget(client, { target: "the New Chat entry", table });
    assert.ok(found.status === "matched");
    assert.deepEqual(found.line.center, { x: 100, y: 130 });
  });

  it("reports uncertainty instead of guessing", async () => {
    stubJev((body) => ({
      target: { type: "choice", choice: idFor(body, "New Chat"), probabilities: { [idFor(body, "New Chat")]: 0.45, [idFor(body, "Chat")]: 0.4 }, confidence: 0.2 },
      present: noul(0.9),
    }));
    const found = await locateTarget(client, { target: "chat", table });
    assert.ok(found.status === "uncertain");
    assert.equal(found.candidates.length, 2);
  });

  it("stops before an unauthorized consequential click", async () => {
    stubJev((body) => ({
      operation: choice("click"),
      target: choice(idFor(body, "Delete project")),
      complete: noul(0.05),
      consequential: noul(0.95),
      authorized: noul(0.2),
    }));
    const decision = await decideStep(client, { goal: "open the project list", table, recentActions: [] });
    assert.equal(decision.kind, "stop");
    assert.equal(decision.kind === "stop" ? decision.reason : "", "needs_confirmation");
  });

  it("accepts done only when the screen proves completion", async () => {
    stubJev(() => ({ operation: choice("done", 0.95), target: choice("none"), complete: noul(0.5), consequential: noul(0), authorized: noul(0) }));
    const unsure = await decideStep(client, { goal: "g", table, recentActions: [] });
    assert.equal(unsure.kind === "stop" ? unsure.reason : unsure.kind, "uncertain");
  });
});

function fakeService(frames: ScreenLine[][]) {
  const clicks: Array<{ x: number | undefined; y: number | undefined }> = [];
  let frame = 0;
  let current: ScreenLine[] = [];
  const svc = {
    platform: "windows",
    ocrScreen: async (input: { region?: Rect }) => {
      if (!input.region || input.region.width >= 200) current = frames[Math.min(frame++, frames.length - 1)]!;
      return { lines: current, area, hidden: {} };
    },
    mouseClick: async (input: { x?: number; y?: number }) => {
      clicks.push({ x: input.x, y: input.y });
      return {};
    },
    mouseMove: async () => ({}),
    mouseScroll: async () => ({}),
  } as unknown as ComputerUseService;
  return { svc, clicks };
}

describe("pursue loop", () => {
  it("clicks locally until Jev sees the goal reached", async () => {
    const settings = line("Settings", 120, 40);
    const { svc, clicks } = fakeService([[settings, line("Home", 40, 40)], [line("Account", 80, 200)]]);
    stubJev((body, call) => call === 1
      ? { operation: choice("click"), target: choice(idFor(body, "Settings")), complete: noul(0.02), consequential: noul(0.05), authorized: noul(0.1) }
      : { operation: choice("done", 0.97), target: choice("none"), complete: noul(0.96), consequential: noul(0), authorized: noul(0) });
    const result = await runPursue(
      { goal: "open Settings", maxSteps: 4, lang: "en", resolveArea: async () => area },
      { svc, client, options: {}, detectTakeover: async () => null },
    );
    assert.equal(result.outcome, "done");
    assert.deepEqual(clicks, [{ x: 120, y: 40 }]);
  });

  it("stops when the user takes the mouse", async () => {
    const { svc, clicks } = fakeService([[line("Settings", 120, 40)]]);
    const result = await runPursue(
      { goal: "open Settings", maxSteps: 4, lang: "en", resolveArea: async () => area },
      { svc, client, options: {}, detectTakeover: async () => ({ outcome: "done", via: "screen", waitedMs: 0, shownOnScreen: true }) },
    );
    assert.equal(result.outcome, "user_took_over");
    assert.equal(clicks.length, 0);
  });
});

type BackendCall = { cmd: string; args: Record<string, unknown> };

function ocrBackend(
  lines: Array<{ text: string; x: number; y: number; width: number; height: number }>,
  overrides: Record<string, unknown> = {},
  calls: BackendCall[] = [],
): ComputerUseBackend {
  return {
    platform: "windows",
    async request<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
      calls.push({ cmd, args });
      const region = args.region as number[] | undefined;
      const rect = region ? { x: region[0], y: region[1], width: region[2], height: region[3] } : area;
      const override = overrides[cmd];
      if (typeof override === "function") return override(args) as T;
      const canned: Record<string, unknown> = {
        "screen.capture": { path: "x.png", width: rect.width, height: rect.height, rect },
        "screen.ocr": { lines },
        "system.info": { frontmost_pid: process.pid },
        screens: { screens: [{ id: 1, is_main: true, ...area, scale: 1, pixels_wide: 900, pixels_high: 600 }] },
        "mouse.position": { x: 1, y: 1 },
        ...overrides,
      };
      return (canned[cmd] ?? {}) as T;
    },
  };
}

const bigWindow = { x: 0, y: 0, width: 3840, height: 2100 };
const chromeFront = {
  screens: { screens: [{ id: 1, is_main: true, ...bigWindow, scale: 1, pixels_wide: 3840, pixels_high: 2100 }] },
  "system.info": { frontmost_pid: 4242 },
  "ui.batch_state": { pid: 4242, window: { id: "w1", title: "Chrome", frame: bigWindow }, modal: false },
};

function quietWindows(): WindowAvoidance {
  const w = new WindowAvoidance({ settleMs: 0, idleRestoreMs: 60_000 });
  w.configure(null);
  return w;
}

describe("computer tools with and without Jev", () => {
  const context = { workspacePath: "/tmp", fullPermissionsEnabled: true } as ToolExecuteContext;

  async function withCache<T>(run: () => Promise<T>): Promise<T> {
    const root = await mkdtemp(join(tmpdir(), "jellybot-jev-test-"));
    configureComputerUseCache(root);
    try {
      return await run();
    } finally {
      configureComputerUseCache(null);
      await rm(root, { recursive: true, force: true });
    }
  }

  it("find_text falls back to Jev for an OCR misspelling", () => withCache(async () => {
    setComputerUseServiceForTests(new ComputerUseService(ocrBackend([{ text: "Automatlons", x: 80, y: 180, width: 70, height: 20 }]), quietWindows()));
    configureComputerUseJev(async () => client);
    stubJev((body) => ({ target: choice(idFor(body, "Automatlons")), present: noul(0.95) }));
    const result = await computerScreenHandler({ action: "find_text", text: "Automations" }, context);
    assert.equal(result.returnCode, ToolReturnCode.Success);
    const payload = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(payload.matched_by, "jev");
    assert.deepEqual(payload.center, { x: 115, y: 190 });
  }));

  it("keeps the current behavior when no Jev model is configured", () => withCache(async () => {
    setComputerUseServiceForTests(new ComputerUseService(ocrBackend([{ text: "Automatlons", x: 80, y: 180, width: 70, height: 20 }]), quietWindows()));
    const missing = await computerScreenHandler({ action: "find_text", text: "Automations" }, context);
    assert.equal(missing.returnCode, ToolReturnCode.NotFound);
    const pursue = await computerScreenHandler({ action: "pursue", goal: "open automations" }, context);
    assert.equal(pursue.returnCode, ToolReturnCode.NotFound);
    const located = await computerScreenHandler({ action: "locate", target: "the automations entry" }, context);
    assert.equal(JSON.parse((located.content[0] as { text: string }).text).status, "no_jev");
    const clicked = await computerMouseHandler({ action: "click", x: 10, y: 10, expect: "Automations opened" }, context);
    assert.equal(JSON.parse((clicked.content[0] as { text: string }).text).verification.status, "skipped");
  }));

  const payloadOf = (result: { content: unknown[] }) => JSON.parse((result.content[0] as { text: string }).text);
  const screenChecks = (calls: JevBody[]) => calls.filter((c) => "dialog" in c.questions).length;

  it("reports not_checkable for expectations that screen text cannot show", () => withCache(async () => {
    setComputerUseServiceForTests(new ComputerUseService(ocrBackend([{ text: "Search", x: 10, y: 10, width: 60, height: 20 }], chromeFront), quietWindows()));
    configureComputerUseJev(async () => client);
    const jev = stubJev(() => ({ dialog: noul(0.05), error: noul(0.05), expected: noul(0.1), checkable: noul(0.08) }));
    const clicked = await computerMouseHandler({ action: "click", x: 2000, y: 230, expect: "the search box has keyboard focus" }, context);
    assert.equal(payloadOf(clicked).verification.expected, "not_checkable");
    assert.equal(screenChecks(jev.calls), 1);
    assert.deepEqual(jev.calls.find((c) => "checkable" in c.questions)!.state, { claim: "the search box has keyboard focus" });
  }));

  it("answers a clear no once and reads only the area around the click", () => withCache(async () => {
    const calls: BackendCall[] = [];
    setComputerUseServiceForTests(new ComputerUseService(ocrBackend([{ text: "Home", x: 10, y: 10, width: 60, height: 20 }], chromeFront, calls), quietWindows()));
    configureComputerUseJev(async () => client);
    const jev = stubJev(() => ({ dialog: noul(0.05), error: noul(0.05), expected: noul(0.02), checkable: noul(0.95) }));
    const clicked = await computerMouseHandler({ action: "click", x: 3800, y: 40, expect: "the Settings page title is shown" }, context);
    assert.equal(payloadOf(clicked).verification.expected, "no");
    assert.equal(screenChecks(jev.calls), 1);
    const region = calls.find((c) => c.cmd === "screen.capture")!.args.region as number[];
    assert.deepEqual(region, [2040, 0, 1800, 1200]);
  }));

  it("reads the window that received a background click, not the frontmost one", () => withCache(async () => {
    const calls: BackendCall[] = [];
    setComputerUseServiceForTests(new ComputerUseService(ocrBackend([{ text: "All Code Is Slop", x: 2100, y: 300, width: 300, height: 30 }], {
      screens: chromeFront.screens,
      "system.info": { frontmost_pid: 777 },
      "ui.find_app": (args: Record<string, unknown>) => ({ app: { pid: args.target, name: "chrome.exe", bundle_id: "" } }),
      "ui.batch_state": (args: Record<string, unknown>) => args.pid === 21440
        ? { pid: 21440, window: { id: "chrome", title: "YouTube", frame: bigWindow }, modal: false }
        : { pid: 777, window: { id: "tiny", title: "", frame: { x: 0, y: 0, width: 60, height: 20 } }, modal: false },
      "input.click_at": { delivery: { mode: "background", pid: 21440, app: "chrome.exe", activated: false } },
    }, calls), quietWindows()));
    configureComputerUseJev(async () => client);
    stubJev(() => ({ dialog: noul(0.05), error: noul(0.05), expected: noul(0.93), checkable: noul(0.9) }));
    const clicked = await computerMouseHandler({ action: "click", x: 2252, y: 844, expect: "a watch page for All Code Is Slop opens" }, context);
    assert.equal(payloadOf(clicked).verification.expected, "yes");
    const region = calls.find((c) => c.cmd === "screen.capture")!.args.region as number[];
    assert.deepEqual(region, [1352, 244, 1800, 1200]);
  }));

  it("wait_for stops once the screen settles instead of waiting out the timeout", () => withCache(async () => {
    setComputerUseServiceForTests(new ComputerUseService(ocrBackend([{ text: "Lauren Tan talks", x: 10, y: 10, width: 120, height: 20 }]), quietWindows()));
    configureComputerUseJev(async () => client);
    const jev = stubJev(() => ({ dialog: noul(0.05), error: noul(0.05), expected: noul(0.03), checkable: noul(0.9) }));
    const started = performance.now();
    const result = payloadOf(await computerScreenHandler({ action: "wait_for", text: "State of React", timeout_s: 15 }, context));
    assert.equal(result.satisfied, false);
    assert.equal(result.status, "settled");
    assert.ok(performance.now() - started < 4000);
    assert.equal(screenChecks(jev.calls), 1);
  }));

  it("types URLs fast and keeps short text human-paced", () => withCache(async () => {
    const calls: BackendCall[] = [];
    setComputerUseServiceForTests(new ComputerUseService(ocrBackend([], {}, calls), quietWindows()));
    const sleeps = () => calls
      .filter((c) => c.cmd === "input.sequence")
      .flatMap((c) => c.args.events as Array<{ t: string; ms?: number }>)
      .filter((e) => e.t === "sleep")
      .map((e) => e.ms!);
    await computerKeyboardHandler({ action: "type", text: "https://www.youtube.com/results?search_query=x" }, context);
    assert.ok(sleeps().length > 0 && sleeps().every((ms) => ms <= 24));
    calls.length = 0;
    await computerKeyboardHandler({ action: "type", text: "hello" }, context);
    assert.ok(sleeps().some((ms) => ms >= 30));
    calls.length = 0;
    await computerKeyboardHandler({ action: "type", text: "https://example.com/a", speed: "human" }, context);
    assert.ok(sleeps().some((ms) => ms >= 30));
  }));

  it("wait_for returns as soon as the text appears and times out otherwise", () => withCache(async () => {
    setComputerUseServiceForTests(new ComputerUseService(ocrBackend([{ text: "Search results", x: 10, y: 10, width: 120, height: 20 }]), quietWindows()));
    const seen = payloadOf(await computerScreenHandler({ action: "wait_for", text: "search results" }, context));
    assert.equal(seen.satisfied, true);
    assert.equal(seen.matched_by, "ocr");
    const missing = payloadOf(await computerScreenHandler({ action: "wait_for", text: "Checkout", timeout_s: 1 }, context));
    assert.equal(missing.satisfied, false);
    assert.equal(missing.status, "timeout");
  }));

  it("handoff screen_shows reads literal OCR text without Jev and asks Jev when configured", () => withCache(async () => {
    const svc = new ComputerUseService(ocrBackend([{ text: "Signed in", x: 10, y: 10, width: 60, height: 20 }]), quietWindows());
    const literal = await parseHandoffRequest({ title: "Sign in", wait_for: { until: "screen_shows", text: "signed in" } }, svc);
    assert.equal(await literal.request.watch!.check(new AbortController().signal), true);

    configureComputerUseJev(async () => client);
    stubJev(() => ({ dialog: noul(0.1), error: noul(0.05), expected: noul(0.92) }));
    const described = await parseHandoffRequest({ title: "Sign in", wait_for: { until: "screen_shows", text: "the sign-in finished" } }, svc);
    assert.equal(await described.request.watch!.check(new AbortController().signal), true);

    await assert.rejects(parseHandoffRequest({ title: "x", wait_for: { until: "appears", name: "OK" } }, svc), /wait_for\.app/);
  }));
});
