import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
const rafs = new Map<number, FrameRequestCallback>();
let rafSeq = 0;
const requestFrame = (cb: FrameRequestCallback): number => {
  const id = ++rafSeq;
  rafs.set(id, cb);
  return id;
};
const cancelFrame = (id: number): void => {
  rafs.delete(id);
};
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
  requestAnimationFrame: requestFrame,
  cancelAnimationFrame: cancelFrame,
  ResizeObserver: class {
    observe(): void {}
    disconnect(): void {}
  },
});
dom.window.requestAnimationFrame = requestFrame;
dom.window.cancelAnimationFrame = cancelFrame;

const timeouts = new Set<unknown>();
const intervals = new Set<unknown>();
const origSetTimeout = global.setTimeout;
const origClearTimeout = global.clearTimeout;
const origSetInterval = global.setInterval;
const origClearInterval = global.clearInterval;
global.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
  const id = origSetTimeout(() => {
    timeouts.delete(id);
    if (typeof fn === "function") fn();
  }, ms, ...rest);
  timeouts.add(id);
  return id;
}) as typeof setTimeout;
global.clearTimeout = ((id: unknown) => {
  timeouts.delete(id);
  return origClearTimeout(id as ReturnType<typeof setTimeout>);
}) as typeof clearTimeout;
global.setInterval = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) => {
  const id = origSetInterval(fn, ms, ...rest);
  intervals.add(id);
  return id;
}) as typeof setInterval;
global.clearInterval = ((id: unknown) => {
  intervals.delete(id);
  return origClearInterval(id as ReturnType<typeof setInterval>);
}) as typeof clearInterval;

type Listener = EventListenerOrEventListenerObject;
const windowListeners: string[] = [];
const origAdd = dom.window.addEventListener.bind(dom.window);
const origRemove = dom.window.removeEventListener.bind(dom.window);
dom.window.addEventListener = ((type: string, fn: Listener, opts?: unknown) => {
  const name = typeof fn === "function" ? fn.name || "anonymous" : "object";
  windowListeners.push(`${type}:${name}`);
  origAdd(type, fn, opts as AddEventListenerOptions | undefined);
}) as typeof dom.window.addEventListener;
dom.window.removeEventListener = ((type: string, fn: Listener, opts?: unknown) => {
  const name = typeof fn === "function" ? fn.name || "anonymous" : "object";
  const key = `${type}:${name}`;
  const index = windowListeners.lastIndexOf(key);
  if (index >= 0) windowListeners.splice(index, 1);
  origRemove(type, fn, opts as EventListenerOptions | undefined);
}) as typeof dom.window.removeEventListener;

function flushFrames(): void {
  for (let i = 0; i < 8 && rafs.size > 0; i++) {
    const batch = [...rafs.entries()];
    rafs.clear();
    for (const [, cb] of batch) {
      try { cb(0); } catch { /* destroyed view */ }
    }
  }
}

function collect(): boolean {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) return false;
  gc();
  return true;
}

function heapMb(): number {
  return Math.round(process.memoryUsage().heapUsed / (1024 * 1024) * 10) / 10;
}

const code = [
  "export function accumulate(values: number[]): number {",
  "  let total = 0;",
  "  for (const value of values) {",
  "    if (!Number.isFinite(value)) continue;",
  "    total += value * 2;",
  "  }",
  "  return total;",
  "}",
].join("\n");

type Message = { id: string; role: string; createdAt: number; parts: Array<Record<string, unknown>> };

function transcript(turns: number, assistantText: (index: number) => string): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push({
      id: `u${i}`,
      role: "user",
      createdAt: 1_700_000_000_000 + i * 2,
      parts: [{ type: "text", text: `Turn ${i}. Please inspect src/agent/turnHost/createTurnHost.ts and explain the compaction gate.` }],
    });
    messages.push({
      id: `a${i}`,
      role: "assistant",
      createdAt: 1_700_000_000_000 + i * 2 + 1,
      parts: [{ type: "text", text: assistantText(i) }],
    });
  }
  return messages;
}

let ConversationView: typeof import("./ConversationView.js").ConversationView;

test.before(async () => {
  ({ ConversationView } = await import("./ConversationView.js"));
});

const options = {
  sessionStatus: "idle" as const,
  revealLabel: "Reveal",
  onOpenFile: () => {},
  onRevealFile: () => {},
  onOpenUrl: () => {},
  onLoadFilePreview: async () => ({ ok: false as const, message: "skip" }),
};

async function cycleTranscript(label: string, messages: Message[], cycles: number): Promise<{ settledMb: number; alive: number }> {
  const refs: Array<WeakRef<InstanceType<typeof ConversationView>>> = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    let view: InstanceType<typeof ConversationView> | null = new ConversationView();
    document.body.append(view.root);
    await view.renderMessages(messages, options);
    refs.push(new WeakRef(view));
    view.destroy();
    view = null;
    flushFrames();
    document.body.replaceChildren();
  }
  await new Promise((resolve) => origSetTimeout(resolve, 30));
  flushFrames();
  collect();
  collect();
  const alive = refs.filter((ref) => ref.deref()).length;
  const settledMb = heapMb();
  console.log(`[conversation-memory] ${label}`, JSON.stringify({
    settledMb,
    alive,
    timeouts: timeouts.size,
    intervals: intervals.size,
    frames: rafs.size,
  }));
  return { settledMb, alive };
}

test("conversation views release DOM, timers and heap across render and destroy cycles", async () => {
  const plain = await cycleTranscript("plain", transcript(12, (i) => `Answer ${i}. The compaction gate reads the provider usage and keeps the newest iterations raw.`), 8);
  const highlighted = await cycleTranscript("code", transcript(12, (i) => `Helper ${i}.\n\n\`\`\`ts\n${code}\n// turn ${i}\n\`\`\``), 8);
  const diagrams = await cycleTranscript("mermaid", transcript(4, () => "```mermaid\nflowchart LR\n  A[Send] --> B[Model]\n  B --> C[Tools]\n  C --> B\n```"), 8);
  const again = await cycleTranscript("plain-again", transcript(12, (i) => `Answer ${i}. The compaction gate reads the provider usage and keeps the newest iterations raw.`), 8);

  const report = {
    frames: rafs.size,
    timeouts: timeouts.size,
    intervals: intervals.size,
    windowListeners: [...windowListeners],
    mermaidNodes: document.querySelectorAll("[id^='jb-mermaid'], [id^='mermaid-']").length,
    nodes: document.querySelectorAll("*").length,
    plainMb: plain.settledMb,
    codeMb: highlighted.settledMb,
    mermaidMb: diagrams.settledMb,
    plainAgainMb: again.settledMb,
  };
  console.log("[conversation-memory] retain", JSON.stringify(report));

  assert.equal(report.intervals, 0, "reasoning ticker survived destroy");
  assert.equal(report.frames, 0, "animation frames kept scheduling after destroy");
  assert.equal(report.timeouts, 0, "timers survived destroy");
  assert.ok(report.windowListeners.length <= 1, `window listeners left: ${report.windowListeners.join(", ")}`);
  assert.equal(report.mermaidNodes, 0, "mermaid left nodes in the document");
  const gcRan = typeof (globalThis as { gc?: () => void }).gc === "function";
  if (gcRan) {
    assert.equal(plain.alive, 0, "plain conversation views stayed reachable");
    assert.equal(highlighted.alive, 0, "code conversation views stayed reachable");
    assert.equal(diagrams.alive, 0, "mermaid conversation views stayed reachable");
    assert.equal(again.alive, 0, "later conversation views stayed reachable");
    assert.ok(
      again.settledMb - diagrams.settledMb < 4,
      `settled heap grew ${again.settledMb - diagrams.settledMb} MB after diagrams were released`,
    );
  }
});
