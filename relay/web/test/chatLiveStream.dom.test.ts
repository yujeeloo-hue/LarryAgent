/**
 * DOM tests: ChatLiveStream streaming semantics — hidden tool calls fold into
 * one Thinking aggregation block (title chip hint, no card; Mac parity),
 * revealed reply text pins the block so thought after it opens a fresh one,
 * short chatter stays held until substantial, live Thinking starts collapsed
 * and collapses to Thought when the reply begins (ReasoningBlockView parity),
 * the expanded body keeps chasing its own bottom while CoT streams,
 * tool_finished paints no fake "Done" state, and refreshToolCards swaps
 * running cards for snapshot-built ones carrying the real status / return
 * code (Mac renderFinishedTool parity).
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  // linkedom lacks HTMLDetailsElement; the card code only uses it for `instanceof`.
  HTMLDetailsElement: class HTMLDetailsElement extends dom.HTMLElement {},
}));

const { ChatLiveStream } = await import("../src/chat.js");
import type { Session, StreamEvent } from "../src/types.js";

function live(): { stream: InstanceType<typeof ChatLiveStream>; flow: HTMLElement } {
  const flow = document.createElement("div");
  const scroller = document.createElement("div");
  scroller.append(flow);
  document.body.append(scroller);
  return { stream: new ChatLiveStream(flow, scroller), flow };
}

const delta = (type: "reasoning_delta" | "text_delta", text: string) => ({ type, text }) as StreamEvent;
/** Card-painted tool (conversation allowlist): write_file renders a rich card. */
const cardCall = (id: string) => ({
  type: "tool_call",
  id,
  name: "write_file",
  arguments: { path: "out/report.md", content: "hello" },
  argumentsRaw: "",
}) as StreamEvent;
/** Hidden shell tool: paints no card — just a Thinking-title hint chip. */
const shellCall = (id: string) => ({
  type: "tool_call",
  id,
  name: "run_shell",
  arguments: { command: "npm test" },
  argumentsRaw: "",
}) as StreamEvent;
/** Reply text segment (blank-line break included). */
const replyDelta = (text: string) => delta("text_delta", `${text}\n\nMore detail follows.`);

test("reply text paints in place; hidden tools take their own Thinking blocks", () => {
  const { stream, flow } = live();
  // Thought opens a block; reply text paints below it and pins the block.
  // A hidden shell call after the text opens its OWN block (title chip, no
  // card) — the painted text never folds into Thinking (Mac parity).
  stream.apply(delta("reasoning_delta", "first thought"));
  stream.apply(delta("text_delta", "running the tests")); // paints at once
  stream.apply(shellCall("t0"));
  stream.apply(delta("reasoning_delta", " then more"));
  let blocks = [...flow.querySelectorAll(".conversation-reasoning")];
  assert.equal(blocks.length, 2, "hidden tool after painted text opens its own block");
  assert.equal(flow.querySelectorAll(".content-card-tool-invocation").length, 0, "plain shell call paints no card");
  assert.match(
    blocks[1]!.querySelector(".conversation-reasoning-chip")?.getAttribute("title") ?? "",
    /^Shell npm test$/,
    "hidden call leaves a title chip hint",
  );

  // A visible card lands after the reply; thought after it opens a FRESH
  // block below the card and the next reply segment takes a fresh text host.
  stream.apply(replyDelta("Applying the fix now."));
  stream.apply(cardCall("t1"));
  stream.apply(delta("reasoning_delta", " verify"));
  stream.apply(replyDelta("All set."));
  stream.finish();

  blocks = [...flow.querySelectorAll(".conversation-reasoning")];
  assert.equal(blocks.length, 3, "thought after pinned reply text opens a fresh block");
  const body = flow.querySelector(".conversation-msg-body")!;
  const children = [...body.children];
  const hosts = [...body.querySelectorAll(".message-part-text")].filter(
    (host) => (host.textContent ?? "").length > 0,
  );
  assert.equal(hosts.length, 3, "reply text interrupted by thinking = per-segment hosts");
  assert.ok(children.indexOf(blocks[0]!) < children.indexOf(hosts[0]!), "block 1 above the first reply");
  assert.ok(children.indexOf(hosts[0]!) < children.indexOf(blocks[1]!), "presented reply stays above the new block");
  assert.ok(children.indexOf(blocks[1]!) < children.indexOf(hosts[1]!), "new block above the second reply");
  assert.equal(hosts[0]!.textContent ?? "", "running the tests", "narration paints, never folds");
  assert.match(hosts[1]!.textContent ?? "", /Applying the fix now\./);
  assert.ok(children.indexOf(blocks[2]!) < children.indexOf(hosts[2]!), "third block above the last reply");
  assert.match(hosts[2]!.textContent ?? "", /All set\./);

  // Both blocks finalized by their following reply: full body paint,
  // collapsed Thought blocks (Mac finalizeStreamingReasoning parity).
  // Hidden-tool calls also land as structured records under the CoT (V1
  // list) — the body text reads from the CoT child (desktop parity).
  const cotOf = (b: Element) => b.querySelector(".conversation-reasoning-cot")!.textContent;
  assert.deepEqual(blocks.map(cotOf), ["first thought", " then more", " verify"]);
  const toollogs = blocks.map((b) => b.querySelector(".conversation-reasoning-toollog"));
  assert.ok(toollogs[1], "hidden tool record lives in the expanded body");
  assert.equal(
    toollogs[1]!.querySelector(".conversation-reasoning-toollog-name")!.textContent,
    "Shell",
  );
  assert.equal(
    toollogs[1]!.querySelector(".conversation-reasoning-toollog-detail")!.textContent,
    "npm test",
  );
  assert.ok(!toollogs[1]!.querySelector(".conversation-reasoning-toollog-dur"), "no duration until the snapshot stamps it");
  assert.ok(!toollogs[0], "pure-CoT block has no tool record");
  for (const b of blocks) {
    assert.equal(b.dataset.mode, "collapsed", "collapsed to Thought once the reply began");
    assert.ok(!b.classList.contains("is-open"));
  }
});

test("live thinking starts collapsed; expanding mid-stream paints the buffered tail", async () => {
  const { stream, flow } = live();
  stream.apply(delta("reasoning_delta", "plan A"));
  const block = flow.querySelector(".conversation-reasoning") as HTMLElement;
  assert.equal(block.dataset.mode, "streaming", "spinner mode while CoT flows");
  assert.ok(!block.classList.contains("is-open"), "starts collapsed (Mac parity)");
  assert.equal(
    block.querySelector(".conversation-reasoning-body")!.textContent,
    "",
    "no body churn while collapsed",
  );
  assert.match(
    block.querySelector(".conversation-reasoning-title")!.textContent ?? "",
    /^Thinking…$/,
    "streaming title",
  );

  // Expand mid-flight → immediate tail paint.
  (block.querySelector(".conversation-reasoning-toggle") as HTMLElement).click();
  assert.ok(block.classList.contains("is-open"));
  assert.equal(block.querySelector(".conversation-reasoning-body")!.textContent, "plan A");

  // Further deltas keep painting the expanded tail (throttled flush).
  stream.apply(delta("reasoning_delta", " then plan B"));
  await new Promise((resolve) => setTimeout(resolve, 180));
  assert.equal(block.querySelector(".conversation-reasoning-body")!.textContent, "plan A then plan B");

  // A substantial reply reveals at once and collapses it to Thought with
  // the full body painted (short chatter alone stays held, never paints).
  stream.apply(replyDelta("Here is the answer."));
  assert.equal(block.dataset.mode, "collapsed");
  assert.ok(!block.classList.contains("is-open"));
  assert.equal(block.querySelector(".conversation-reasoning-body")!.textContent, "plan A then plan B");
  // The title flips on the token-chase's next frame (Mac parity — the label
  // rides the stats paint, not the collapse itself).
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(
    block.querySelector(".conversation-reasoning-title")!.textContent ?? "",
    /^Thought$/,
    "finalized title",
  );
});

test("expanded thinking body keeps chasing its own bottom while streaming", async () => {
  const { stream, flow } = live();
  stream.apply(delta("reasoning_delta", "step 1"));
  const block = flow.querySelector(".conversation-reasoning") as HTMLElement;
  (block.querySelector(".conversation-reasoning-toggle") as HTMLElement).click();
  const body = block.querySelector(".conversation-reasoning-body") as HTMLElement;
  // Stand-in layout: linkedom has no layout engine — the tail sits far below
  // the fold and scrollTop starts pinned at 0 (undefined in linkedom).
  let scrollTop = 0;
  Object.defineProperty(body, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => { scrollTop = v; },
    configurable: true,
  });
  Object.defineProperty(body, "scrollHeight", { value: 1000, configurable: true });
  Object.defineProperty(body, "clientHeight", { value: 200, configurable: true });

  stream.apply(delta("reasoning_delta", " step 2"));
  await new Promise((resolve) => setTimeout(resolve, 240)); // paint throttle + a few chase frames
  assert.ok(body.scrollTop > 0, "body scrolled toward the newest reasoning");
  await new Promise((resolve) => setTimeout(resolve, 520));
  assert.equal(body.scrollTop, 800, "eased chase settles at the bottom");

  const wheel = new dom.window.Event("wheel", { bubbles: true });
  Object.assign(wheel, { deltaY: -100 });
  body.dispatchEvent(wheel);
  body.scrollTop = 200;
  stream.apply(delta("reasoning_delta", " step 3 while reading"));
  await new Promise((resolve) => setTimeout(resolve, 240));
  assert.equal(stream.autoScroll.following, false, "nested wheel pauses the transcript too");
  assert.equal(body.scrollTop, 200, "new reasoning respects the reader's offset");

  stream.autoScroll.follow();
  stream.apply(delta("reasoning_delta", " step 4 after resume"));
  await new Promise((resolve) => setTimeout(resolve, 760));
  assert.equal(body.scrollTop, 800, "explicit resume restores the Thinking chase");

  stream.finish(); // drop the meta ticker + chase timers before teardown
  stream.destroy();
});

test("finish() collapses a still-streaming thinking block (done parity)", () => {
  const { stream, flow } = live();
  stream.apply(delta("reasoning_delta", "half a thought"));
  const block = flow.querySelector(".conversation-reasoning") as HTMLElement;
  assert.equal(block.dataset.mode, "streaming");

  stream.finish();
  assert.equal(block.dataset.mode, "collapsed");
  assert.ok(!block.classList.contains("is-open"));
  assert.equal(
    block.querySelector(".conversation-reasoning-body")!.textContent,
    "half a thought",
    "full flush on finalize",
  );
});

test("continuous text deltas within one segment share a single host", async () => {
  const { stream, flow } = live();
  // Every delta paints into the same host the moment it arrives (180ms
  // render throttle aside) — no hold-off, no fold.
  stream.apply(delta("text_delta", "answer "));
  stream.apply(delta("text_delta", "part one. "));
  stream.apply(delta("text_delta", "part two."));
  assert.ok(flow.querySelector(".conversation-msg-body"), "reply paints from the first delta");

  // Later deltas keep appending to the same host.
  stream.apply(delta("text_delta", "\n\nthat was the run."));
  stream.apply(delta("text_delta", " tail"));
  await new Promise((resolve) => setTimeout(resolve, 220));
  const hosts = [...flow.querySelectorAll(".message-part-text")];
  assert.equal(hosts.length, 1, "no interruption → no host split");
  const text = hosts[0]!.textContent ?? "";
  assert.match(text, /answer part one\. part two\./, "segments concatenate in place");
  assert.match(text, /that was the run\./);
  assert.match(text, /tail$/);
});

test("tool_finished paints no fake Done state on running cards", () => {
  const { stream, flow } = live();
  stream.apply(cardCall("t1"));
  const card = flow.querySelector(".content-card-tool-invocation") as HTMLElement;
  assert.ok(card.classList.contains("content-card-tool-running"));

  stream.apply({ type: "tool_finished", id: "t1", messageId: "m1" } as StreamEvent);
  const after = flow.querySelector(".content-card-tool-invocation") as HTMLElement;
  assert.ok(after.classList.contains("content-card-tool-running"), "stays running until the snapshot lands");
  assert.ok(after.querySelector(".content-card-tool-run-spinner"), "spinner carries the running state");
  assert.equal(after.querySelector(".content-card-tool-outcome"), null, "no outcome badge before the snapshot");
});

test("refreshToolCards swaps running cards for snapshot-built results", () => {
  const { stream, flow } = live();
  stream.apply(cardCall("t1"));
  stream.apply(cardCall("t2"));

  const session = {
    id: "s1",
    title: "t",
    status: "running",
    messages: [
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "t1", name: "write_file", status: "error", arguments: { path: "out/report.md", content: "hello" }, argumentsRaw: "" },
          { type: "tool_call", id: "t2", name: "write_file", status: "running", arguments: { path: "out/draft.md", content: "wip" }, argumentsRaw: "" },
        ],
      },
      {
        role: "tool",
        parts: [
          { type: "tool_result", toolCallId: "t1", content: "boom", returnCode: 1, executionSummary: "1 error" },
        ],
      },
    ],
  } as unknown as Session;

  stream.refreshToolCards(session);

  const cards = [...flow.querySelectorAll(".content-card-tool-invocation[data-tool-call-id]")];
  assert.equal(cards.length, 2);
  const byId = new Map(cards.map((c) => [c.dataset.toolCallId, c]));
  // t1 finished with returnCode 1 → error outcome rendered from the snapshot.
  const t1 = byId.get("t1")!;
  assert.ok(!t1.classList.contains("content-card-tool-running"));
  assert.ok(t1.classList.contains("is-error"), "error status from returnCode");
  assert.ok(t1.querySelector(".content-card-tool-outcome.is-fail"), "failed exit badge");
  // t2 still pending → stays a running card.
  assert.ok(byId.get("t2")!.classList.contains("content-card-tool-running"));
});

test("refreshToolCards preserves the expanded state across the swap", () => {
  const { stream, flow } = live();
  stream.apply(cardCall("t1"));
  const card = flow.querySelector(".content-card-tool-invocation") as HTMLDetailsElement;
  if (card.tagName === "DETAILS") card.open = true;

  const session = {
    id: "s1",
    title: "t",
    status: "running",
    messages: [
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "t1", name: "write_file", status: "done", arguments: { path: "out/report.md", content: "hello" }, argumentsRaw: "" },
        ],
      },
      {
        role: "tool",
        parts: [
          { type: "tool_result", toolCallId: "t1", content: "ok", returnCode: 0, executionSummary: "ok" },
        ],
      },
    ],
  } as unknown as Session;

  stream.refreshToolCards(session);
  const fresh = flow.querySelector(".content-card-tool-invocation[data-tool-call-id='t1']") as HTMLDetailsElement;
  if (fresh.tagName === "DETAILS" && card.tagName === "DETAILS") {
    assert.equal(fresh.open, card.open);
  }
});

test("success badge is dormant in history, armed on live finish, fades after 3s", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { stream, flow } = live();
  stream.apply(cardCall("t1"));

  const session = (status: string) => ({
    id: "s1",
    title: "t",
    status: "running",
    messages: [
      {
        role: "assistant",
        parts: [
          { type: "tool_call", id: "t1", name: "write_file", status, arguments: { path: "out/report.md", content: "hello" }, argumentsRaw: "" },
        ],
      },
      {
        role: "tool",
        parts: [
          { type: "tool_result", toolCallId: "t1", content: "ok", returnCode: 0, executionSummary: "ok" },
        ],
      },
    ],
  }) as unknown as Session;

  // Live finish: running card swaps for the snapshot card and arms the badge.
  stream.refreshToolCards(session("done"));
  let badge = flow.querySelector(".content-card-tool-outcome.is-ok") as HTMLElement;
  assert.ok(badge, "success badge exists");
  assert.ok(!badge.classList.contains("is-dormant"), "armed — revealed");
  assert.ok(!badge.classList.contains("is-faded"), "still visible right after the finish");

  // Hold for 3s → fades out (transition happens in CSS; class marks the state).
  t.mock.timers.tick(2999);
  assert.ok(!badge.classList.contains("is-faded"), "held for ~3s");
  t.mock.timers.tick(1);
  assert.ok(badge.classList.contains("is-faded"), "faded after the 3s hold");

  // A later refresh rebuilds the card from history — badge stays hidden and
  // the 3s hold never restarts.
  stream.refreshToolCards(session("done"));
  badge = flow.querySelector(".content-card-tool-outcome.is-ok") as HTMLElement;
  assert.ok(badge.classList.contains("is-dormant"), "history rebuild keeps the badge dormant");
});
