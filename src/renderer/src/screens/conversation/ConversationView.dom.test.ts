import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import { RETRY_CONTINUATION_PART_ID, STEER_CONTINUATION_PART_ID } from "../../../../session/types.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  ResizeObserver: class { observe() {} disconnect() {} },
});

type View = import("./ConversationView.js").ConversationView;
type ViewModule = typeof import("./ConversationView.js");
type Message = { id: string; role: string; createdAt: number; parts: Array<Record<string, unknown>> };
let ConversationView: ViewModule["ConversationView"];
let createMessageViewAsync: typeof import("./message/MessageView.js").createMessageViewAsync;
let buildMessageRenderContext: typeof import("./buildMessageRenderContext.js").buildMessageRenderContext;

test.before(async () => {
  ({ ConversationView } = await import("./ConversationView.js"));
  ({ createMessageViewAsync } = await import("./message/MessageView.js"));
  ({ buildMessageRenderContext } = await import("./buildMessageRenderContext.js"));
});
test.afterEach(() => document.body.replaceChildren());

const options: import("./ConversationView.js").RenderMessagesOptions = {
  sessionStatus: "cancelled",
  revealLabel: "Reveal",
  onOpenFile: () => {},
  onRevealFile: () => {},
  onOpenUrl: () => {},
  onLoadFilePreview: async () => null,
};

function message(id: string, role: string, text: string, steer = false): Message {
  return {
    id, role, createdAt: 1000,
    parts: [{ type: "text", text, ...(steer ? { id: STEER_CONTINUATION_PART_ID } : {}) }],
  };
}

async function makeView(messages: Message[]) {
  // Use real message rendering, turn layout and finalization; omit unrelated
  // composer/scroll setup so this tests the live transcript DOM in isolation.
  const list = document.createElement("div");
  document.body.append(list);
  const view = Object.assign(Object.create(ConversationView.prototype), {
    messagesListEl: list,
    renderMessagesGeneration: 0,
    finalizeStreamingDisplay: () => {},
    checkPromptVisibility: () => {},
    applyUserPromptReclaimability: () => {},
    scrollToBottomIfStuck: () => {},
    // Scroll intent is covered by the reveal tests; keep the transcript DOM
    // tests free of viewport geometry.
    scrollViewport: { isFullyVisible: () => true },
    autoScroll: { following: true, follow: () => {}, snapIfFollowing: () => {} },
  }) as View & { layoutTurns(): void };
  const ctx = buildMessageRenderContext(messages, options);
  for (const msg of messages) {
    const row = await createMessageViewAsync(msg, ctx);
    if (row) list.append(row);
  }
  view.layoutTurns();
  return { view, list };
}

function renderedIds(list: HTMLElement): string[] {
  return Array.from(list.querySelectorAll<HTMLElement>(".conversation-msg[data-message-id]"))
    .map((row) => row.dataset.messageId!);
}

test("Stop finalizes an interrupted turn once without appending copies of its prompts", async () => {
  const history = [message("old-user", "user", "same prompt"), message("old-assistant", "assistant", "old answer")];
  const turn = [
    message("user", "user", "same prompt"),
    message("assistant", "assistant", "partial answer"),
    message("steer-1", "user", "new instructions", true),
    message("assistant-1", "assistant", "partial continuation"),
    message("steer-2", "user", "new instructions", true),
    message("assistant-2", "assistant", "stopped here"),
  ];
  const { view, list } = await makeView([...history, ...turn]);
  const expected = [...history, ...turn].map((msg) => msg.id);
  assert.deepEqual(renderedIds(list), expected);
  // status + done can each schedule a finalization after Stop.
  assert.equal(await view.finalizeTurn(turn, options), true);
  assert.deepEqual(renderedIds(list), expected);
  assert.equal(await view.finalizeTurn(turn, options), true);
  assert.deepEqual(renderedIds(list), expected);
  assert.equal(list.querySelectorAll(".turn-ended").length, 1);
  assert.equal(list.querySelectorAll(".conversation-turn").length, 2);
});

test("a prompt-less turn opens its own turn below the previous Completed footer", async () => {
  const done = [message("u1", "user", "hello"), message("a1", "assistant", "hi")];
  const { view, list } = await makeView(done);
  assert.equal(await view.finalizeTurn(done, options), true);
  assert.equal(list.querySelectorAll(".turn-ended").length, 1);

  view.expectTurnWithoutPrompt();
  try {
    view.appendStreamingReasoning("checking projects ", "auto-1");
    const turns = list.querySelectorAll<HTMLElement>(":scope > .conversation-turn");
    assert.equal(turns.length, 2, "automatic turn gets its own container");
    const block = list.querySelector<HTMLElement>("[data-turn-reasoning='1'][data-ephemeral='1']")!;
    assert.ok(turns[1]!.contains(block), "Thinking is not painted inside the finished turn");
    assert.ok(turns[0]!.querySelector(".turn-ended"), "footer stays with its own turn");
    assert.equal(turns[1]!.querySelector(".turn-ended"), null);
    // Ids not delivered yet: the tail still merges both turns — rebuild instead of duplicating.
    assert.equal(await view.finalizeTurn([...done, message("auto-1", "assistant", "No news.")], options), false);
  } finally {
    view.finalizeStreamingReasoning();
  }
});

test("a prompt that arrives after the first status row drops the live boundary", async () => {
  const done = [message("u1", "user", "hello"), message("a1", "assistant", "hi")];
  const { view, list } = await makeView(done);
  assert.equal(await view.finalizeTurn(done, options), true);
  view.expectTurnWithoutPrompt();
  try {
    view.appendStreamingReasoning("thinking ", "a2");
    const ctx = buildMessageRenderContext([message("u2", "user", "next")], options);
    list.append((await createMessageViewAsync(message("u2", "user", "next"), ctx))!);
    view.layoutTurns();
    assert.equal(list.querySelectorAll(".conversation-turn-boundary").length, 0);
    const turns = list.querySelectorAll<HTMLElement>(":scope > .conversation-turn");
    assert.equal(turns.length, 2);
    assert.ok(turns[1]!.querySelector("[data-turn-reasoning='1']"), "status row joins the prompt's turn");
  } finally {
    view.finalizeStreamingReasoning();
  }
});

test("a follow-up send paints its status row under the new prompt, not inside the finished turn", async () => {
  const { ConversationController } = await import("./ConversationController.js");
  const done = [message("u1", "user", "hello"), message("a1", "assistant", "hi")];
  const { view, list } = await makeView(done);
  assert.equal(await view.finalizeTurn(done, options), true);
  Object.assign(view, { setRunning: () => {} });
  window.jellybot = { startTurn: async () => {} } as unknown as NonNullable<Window["jellybot"]>;
  const controller = Object.assign(Object.create(ConversationController.prototype), {
    sessionId: "s1", view,
    refreshCoalesce: { clearPending: () => {} },
    getPrefs: () => ({ runMode: "react", reasoningEffort: "medium" }),
    syncTurnProgress: (text: string) => view.setStatusLine(text, true),
    syncSendEnabled: () => {},
  });
  try {
    await controller.startFollowUpTurn("next", []);
    const turns = list.querySelectorAll<HTMLElement>(":scope > .conversation-turn");
    assert.equal(turns.length, 2);
    assert.equal(turns[0]!.querySelector("[data-turn-reasoning='1']"), null, "finished turn gains no status row");
    assert.ok(turns[1]!.querySelector(".conversation-msg-user[data-pending-user='1']"));
    assert.ok(turns[1]!.querySelector("[data-turn-reasoning='1'][data-ephemeral='1']"), "status row sits under the new prompt");
  } finally {
    view.finalizeStreamingReasoning();
  }
});

test("a stale idle tail fetched right after Send does not overwrite the new prompt's turn", async () => {
  const { ConversationController } = await import("./ConversationController.js");
  const done = [message("u1", "user", "hello"), message("a1", "assistant", "hi")];
  const { view, list } = await makeView(done);
  assert.equal(await view.finalizeTurn(done, options), true);
  view.appendOptimisticUserMessage("next", []);
  const next = message("u2", "user", "next");
  assert.equal(view.predatesPendingPrompt(done), true);
  assert.equal(view.predatesPendingPrompt([...done, next]), false, "a tail holding the new prompt still finalizes");
  const retry = { id: "r1", role: "user", createdAt: 1000, parts: [{ type: "text", text: "continue", id: RETRY_CONTINUATION_PART_ID }] };
  assert.equal(view.predatesPendingPrompt([...done, retry, message("a2", "assistant", "resumed")]), true, "hidden Retry prompt is not the pending one");
  assert.equal(view.predatesPendingPrompt([message("auto", "assistant", "No news.")]), true, "a prompt-less tail predates the send");

  window.jellybot = {
    getSessionTail: async () => ({ session: { status: "idle", messages: done } }),
  } as unknown as NonNullable<Window["jellybot"]>;
  const controller = Object.assign(Object.create(ConversationController.prototype), {
    destroyed: false, sessionId: "s1", view,
    displaySession: (session: unknown) => session,
    applySessionMetadata: () => assert.fail("stale metadata must not be applied"),
  });
  await controller.finalizeTurn();
  const turns = list.querySelectorAll<HTMLElement>(":scope > .conversation-turn");
  assert.equal(turns.length, 2);
  assert.deepEqual(renderedIds(list), ["u1", "a1"], "previous turn is not duplicated");
  assert.ok(turns[1]!.querySelector(".conversation-msg-user[data-pending-user='1']"), "new prompt stays on screen");
});

test("later reasoning in the same turn appends to the one Thinking card", async () => {
  const { view, list } = await makeView([message("user", "user", "go")]);
  try {
    view.appendStreamingReasoning("thinking about it ", "assistant-a");
    const block = list.querySelector<HTMLElement>("[data-turn-reasoning='1']");
    assert.ok(block, "live Thinking card created");
    assert.equal(block.dataset.mode, "streaming");

    view.appendStreamingReasoning("pivoting ", "assistant-b");
    const blocks = list.querySelectorAll("[data-turn-reasoning='1']");
    assert.equal(blocks.length, 1, "one Thinking card for the turn");
    assert.equal(blocks[0], block);
    assert.equal(block.dataset.mode, "streaming");
    block.querySelector<HTMLButtonElement>(".conversation-reasoning-toggle")?.click();
    assert.match(
      block.querySelector(".conversation-reasoning-body")?.textContent ?? "",
      /thinking about it[\s\S]*pivoting/,
    );
  } finally {
    view.finalizeStreamingReasoning();
  }
});

test("reasoning without any user turn on screen reuses one Thinking card", async () => {
  // CoCo automatic turns suppress the prompt; the hour window may hold no user turn.
  const { view, list } = await makeView([message("greeting", "assistant", "No new progress.")]);
  try {
    view.appendStreamingReasoning("checking in ", "assistant-a");
    view.appendStreamingReasoning("more ", "assistant-a");
    view.appendStreamingReasoning("still thinking", "assistant-a");
    const blocks = list.querySelectorAll<HTMLElement>("[data-turn-reasoning='1']");
    assert.equal(blocks.length, 1, "one Thinking card, not one per delta");
    blocks[0]!.querySelector<HTMLButtonElement>(".conversation-reasoning-toggle")?.click();
    assert.match(
      blocks[0]!.querySelector(".conversation-reasoning-body")?.textContent ?? "",
      /checking in more still thinking/,
    );
  } finally {
    view.finalizeStreamingReasoning();
  }
});

test("short text paints immediately; tool hints ride a separate Thinking block", async () => {
  const { view, list } = await makeView([message("user", "user", "go")]);
  try {
    // makeView stubs finalizeStreamingDisplay; fold/seal need the real one.
    view.finalizeStreamingDisplay = ConversationView.prototype.finalizeStreamingDisplay.bind(view);

    // Reply text paints the moment it streams — no hold-off, no fold.
    assert.equal(view.appendStreamingText("I'll check the file.", "assistant-a"), true);
    const textRow = list.querySelector<HTMLElement>(
      ".conversation-msg-assistant[data-message-id='assistant-a']",
    );
    assert.ok(textRow, "short reply paints immediately");

    // A tool call seals the text row where it is (throttled markdown paint
    // flushes synchronously on the seal).
    view.foldHeldReplyIntoThought();
    assert.equal(textRow.dataset.streaming, undefined, "text row sealed by the tool call");
    assert.match(textRow.textContent ?? "", /I'll check the file\./);
    view.noteTurnToolHint("Read File a.ts");
    view.noteTurnToolHint("Search useAuth");
    const block = list.querySelector<HTMLElement>("[data-turn-reasoning='1']");
    assert.ok(block, "Thinking block opened by the tool call");
    assert.equal(block.dataset.mode, "streaming");
    const tools = block.querySelector(".conversation-reasoning-tools");
    assert.equal(
      tools?.getAttribute("title"),
      "Read File a.ts\nSearch useAuth",
      "full hint list kept on the tooltip",
    );
    const chips = block.querySelectorAll(".conversation-reasoning-chip");
    assert.equal(chips.length, 2, "one chip per hint");
    assert.match(
      tools?.textContent ?? "",
      /a\.ts[\s\S]*useAuth/,
      "chips carry the object text (icon carries the verb)",
    );

    assert.equal(view.appendStreamingText("Done.", "assistant-b"), true);
    const doneRow = list.querySelector<HTMLElement>(
      ".conversation-msg-assistant[data-message-id='assistant-b']",
    );
    assert.ok(doneRow, "next segment paints without folding");
    const order = Array.from(
      list.querySelectorAll(
        ".conversation-msg-assistant[data-message-id='assistant-a'], [data-turn-reasoning='1'], .conversation-msg-assistant[data-message-id='assistant-b']",
      ),
    );
    assert.deepEqual(
      order,
      [textRow, block, doneRow],
      "text row, Thinking block, next reply keep transcript order",
    );
    assert.equal(block.dataset.mode, "collapsed", "Thinking collapses once the reply streams");
    view.finalizeStreamingDisplay();
    assert.equal(block.dataset.mode, "collapsed", "seal keeps the block collapsed");
    block.querySelector<HTMLButtonElement>(".conversation-reasoning-toggle")?.click();
    assert.doesNotMatch(
      block.querySelector(".conversation-reasoning-body")?.textContent ?? "",
      /I'll check the file\./,
      "reply text never folds into Thinking",
    );
  } finally {
    view.finalizeStreamingReasoning();
  }
});

test("Thinking stays above streaming reply text; thinking after the reply opens a new block below it", async () => {
  const { view, list } = await makeView([message("user", "user", "go")]);
  try {
    view.noteTurnToolHint("Read File a.ts");
    const block = list.querySelector<HTMLElement>("[data-turn-reasoning='1']");
    assert.ok(block);
    const reply = "## Findings\n\nThe handler drops the cookie.";
    assert.equal(view.appendStreamingText(reply, "assistant-a"), true);
    const row = list.querySelector(".conversation-msg-assistant[data-message-id='assistant-a']");
    assert.ok(row);
    const order = (): Element[] =>
      Array.from(list.querySelectorAll("[data-turn-reasoning='1'], .conversation-msg-assistant[data-message-id='assistant-a']"));
    assert.equal(order()[0], block, "reply streams below Thinking");
    assert.equal(view.appendStreamingText(" More detail.", "assistant-a"), true);
    assert.equal(order()[0], block, "Thinking does not chase the streaming text");

    view.foldHeldReplyIntoThought();
    view.noteTurnToolHint("Search useAuth");
    const blocks = list.querySelectorAll<HTMLElement>("[data-turn-reasoning='1']");
    assert.equal(blocks.length, 2, "resumed thinking opens a second block");
    assert.equal(blocks[0], block, "the first block stays above the reply");
    assert.equal(block.dataset.mode, "collapsed");
    assert.deepEqual(order(), [block, row, blocks[1]], "new block lands below the reply");
    assert.equal(blocks[1]!.dataset.mode, "streaming");
    assert.equal(blocks[1]!.querySelector(".conversation-reasoning-tools")?.getAttribute("title"), "Search useAuth");

    view.appendStreamingReasoning("more thought ", "assistant-b");
    assert.equal(
      list.querySelectorAll("[data-turn-reasoning='1']").length,
      2,
      "thinking with no reply in between keeps appending to the new block",
    );
  } finally {
    view.finalizeStreamingReasoning();
  }
});

test("a tool card seals Thinking above it; the next iteration's thinking opens a block below", async () => {
  const { view, list } = await makeView([message("user", "user", "go")]);
  try {
    view.appendStreamingReasoning("write the file ", "assistant-a");
    const block = list.querySelector<HTMLElement>("[data-turn-reasoning='1']");
    assert.ok(block?.parentElement);
    const row = document.createElement("article");
    row.className = "conversation-msg conversation-msg-assistant";
    row.dataset.messageId = "assistant-a";
    const card = document.createElement("details");
    card.dataset.toolCallId = "w1";
    row.append(card);
    block.parentElement.append(row);
    view.layoutTurns();

    const order = (): Element[] =>
      Array.from(list.querySelectorAll("[data-turn-reasoning='1'], [data-tool-call-id]"));
    assert.deepEqual(order(), [block, card], "Thinking does not follow the card");
    assert.equal(block.dataset.mode, "collapsed", "block is sealed once a card paints below");

    view.noteTurnToolHint("Read File a.ts");
    view.appendStreamingReasoning("check it ", "assistant-b");
    const blocks = list.querySelectorAll<HTMLElement>("[data-turn-reasoning='1']");
    assert.equal(blocks.length, 2, "next iteration opens a new block");
    assert.deepEqual(order(), [block, card, blocks[1]], "new block lands below the card");
    assert.equal(blocks[1]!.dataset.mode, "streaming");
  } finally {
    view.finalizeStreamingReasoning();
  }
});

test("a newly reconciled steer prompt stays in the current logical turn", async () => {
  const turn = [message("user", "user", "original"), message("assistant", "assistant", "partial")];
  const { view, list } = await makeView(turn);
  const steer = message("steer", "user", "insert now", true);
  view.reconcileUserMessage(steer, buildMessageRenderContext([...turn, steer], options));
  assert.equal(list.querySelectorAll(".conversation-turn").length, 1);
  assert.equal(await view.finalizeTurn([...turn, steer], options), true);
  assert.deepEqual(renderedIds(list), ["user", "assistant", "steer"]);
});

test("an assistant-only greeting stays above the next prompt (CoCo wake)", async () => {
  const { list } = await makeView([
    message("greeting", "assistant", "How has your morning been?"),
    message("prompt", "user", "Plan a review"),
    message("reply", "assistant", "On it"),
  ]);
  // The greeting predates the prompt chronologically — it must render above
  // it, never be swept below (which hoisted the prompt to the very top).
  assert.deepEqual(renderedIds(list), ["greeting", "prompt", "reply"]);
});

test("a reconciled prompt lands below a settled greeting and above its live reply", async () => {
  const greeting = message("greeting", "assistant", "How has your morning been?");
  const { view, list } = await makeView([greeting]);
  // Reply text streams before the persisted prompt is reconciled (flat
  // transcript, no turn yet) — the live row is an orphan above the prompt.
  view.appendStreamingText("partial reply", "reply");
  const prompt = message("prompt", "user", "Plan a review");
  view.reconcileUserMessage(
    prompt,
    buildMessageRenderContext([greeting, prompt, message("reply", "assistant", "partial reply")], options),
  );
  assert.deepEqual(renderedIds(list), ["greeting", "prompt", "reply"]);
});

test("a sent prompt scrolls to the tail only when the reader cannot see it", async () => {
  const done = [message("u1", "user", "hello"), message("a1", "assistant", "hi")];
  const { view } = await makeView(done);
  const calls: string[] = [];
  let visible = false;
  Object.assign(view as unknown as Record<string, unknown>, {
    autoScroll: {
      following: false,
      follow: () => calls.push("follow"),
      snapIfFollowing: () => calls.push("snap"),
    },
    scrollViewport: { isFullyVisible: () => visible },
  });

  // Reader parked up the transcript: the new prompt would land off screen.
  view.appendOptimisticUserMessage("next", []);
  assert.deepEqual(calls, ["follow", "snap"], "an unseen prompt lands on the tail");

  calls.length = 0;
  visible = true;
  view.appendOptimisticUserMessage("next", []);
  assert.deepEqual(calls, [], "a prompt already in view never moves the reader");
});

test("top fade follows the scrollport's top edge", async () => {
  // Mock-inject the two fields updateTopFade reads; the method is the whole
  // state machine (class toggle off scrollTop with an epsilon).
  const messagesEl = document.createElement("div");
  // linkedom clamps scrollTop to scrollHeight - clientHeight (0 by default
  // in a layout-less DOM) — give the element geometry so offsets stick.
  Object.defineProperty(messagesEl, "scrollHeight", { value: 4000 });
  Object.defineProperty(messagesEl, "clientHeight", { value: 600 });
  const topFadeEl = document.createElement("div");
  const view = Object.assign(Object.create(ConversationView.prototype), {
    messagesEl,
    topFadeEl,
  }) as unknown as View;
  const updateTopFade = (
    view as unknown as { updateTopFade(): void }
  ).updateTopFade.bind(view);

  messagesEl.scrollTop = 0;
  updateTopFade();
  assert.equal(topFadeEl.classList.contains("is-on"), false, "off at top");

  messagesEl.scrollTop = 300;
  updateTopFade();
  assert.equal(topFadeEl.classList.contains("is-on"), true, "on when scrolled");

  messagesEl.scrollTop = 3; // just past the epsilon edge — on
  updateTopFade();
  assert.equal(topFadeEl.classList.contains("is-on"), true, "on past epsilon");

  messagesEl.scrollTop = 2; // exactly at the epsilon — off, no edge flicker
  updateTopFade();
  assert.equal(topFadeEl.classList.contains("is-on"), false, "off at epsilon");

  messagesEl.scrollTop = 1; // below epsilon — off, no edge flicker
  updateTopFade();
  assert.equal(topFadeEl.classList.contains("is-on"), false, "off below epsilon");

  messagesEl.scrollTop = 0;
  updateTopFade();
  assert.equal(topFadeEl.classList.contains("is-on"), false, "off back at top");
});

test("a paused transcript stops the expanded Thinking chase", () => {
  const block = document.createElement("section");
  block.dataset.mode = "streaming";
  block.className = "is-open";
  const body = document.createElement("div");
  body.className = "conversation-reasoning-body";
  block.append(body);
  let top = 150;
  Object.defineProperties(body, {
    scrollHeight: { value: 1000 }, clientHeight: { value: 200 },
    scrollTop: { get: () => top, set: value => { top = value; } },
  });
  const autoScroll = { following: false };
  const view = Object.assign(Object.create(ConversationView.prototype), {
    autoScroll, reasoningMessageId: "thought", findTurnReasoningBlock: () => block,
  });
  view.tickSmoothReasoningBodyScroll(block);
  assert.equal(top, 150, "pending animation does not overwrite the reader's position");
  autoScroll.following = true;
  view.tickSmoothReasoningBodyScroll(block);
  assert.ok(top > 150, "Thinking follows again after the transcript resumes");
});

test("a queued Write preview pin respects a later user scroll", () => {
  const card = document.createElement("section");
  const lines = document.createElement("div");
  lines.className = "tool-file-lines";
  card.append(lines);
  let top = 0;
  Object.defineProperties(lines, {
    scrollHeight: { value: 1000 },
    scrollTop: { get: () => top, set: value => { top = value; } },
  });
  const autoScroll = { following: true };
  const view = Object.assign(Object.create(ConversationView.prototype), { autoScroll });
  const original = globalThis.requestAnimationFrame;
  let scheduled = () => {};
  globalThis.requestAnimationFrame = callback => { scheduled = () => callback(0); return 1; };
  try {
    view.scrollStreamingWritePreviewToBottom(card);
    assert.equal(top, 1000);
    autoScroll.following = false;
    top = 200;
    scheduled();
    assert.equal(top, 200, "layout-frame pin cannot override a user scroll");
  } finally {
    globalThis.requestAnimationFrame = original;
  }
});


test("automatic remark history shows speech while normal reasoning remains expandable", async () => {
  const { textOnlyMessages } = await import("./textOnlyMessages.js");
  const messages = [
    message("normal-user", "user", "Explain this"),
    { ...message("normal-answer", "assistant", "Normal answer"), parts: [{type:"reasoning",text:"Normal reasoning evidence"}, {type:"text",text:"Normal answer"}] },
    { ...message("auto-answer", "assistant", "The report is complete"), parts: [{type:"reasoning",text:"Automatic internal reasoning"}, {type:"text",text:"The report is complete"}] },
  ];
  const { list } = await makeView(textOnlyMessages(messages, new Set(["auto-answer"])));
  assert.match(list.textContent ?? "", /The report is complete/);
  assert.doesNotMatch(list.textContent ?? "", /Automatic internal reasoning/);
  assert.match(list.textContent ?? "", /Normal reasoning evidence/);
  assert.equal(list.querySelectorAll(".conversation-reasoning").length, 1);
  assert.equal(messages[2]!.parts.length, 2, "display filtering preserves the original record");
});
