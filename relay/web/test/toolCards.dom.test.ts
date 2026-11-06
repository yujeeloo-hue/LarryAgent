/**
 * DOM smoke test: render patch/edit_file/write_file tool cards through the
 * real web bundle logic (linkedom). Guards against regressions like the
 * missing red/green diff rows.
 */
import { parseHTML } from "linkedom";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

// toolCards touches document/HTMLElement at render time — install linkedom first.
const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  // linkedom lacks HTMLDetailsElement; the card code only uses it for `instanceof`.
  HTMLDetailsElement: class HTMLDetailsElement extends dom.HTMLElement {},
}));

const { armLiveOutcomeFade, createToolInvocationCard } = await import("../src/toolCards.js");
const { renderChatStream } = await import("../src/chat.js");

const diffJson = JSON.stringify({
  lines: [
    { kind: "equal", text: "keep", oldLine: 1, newLine: 1 },
    { kind: "del", text: "old line", oldLine: 2 },
    { kind: "add", text: "new line", newLine: 2 },
  ],
});

test("patch card renders red/green diff rows from file_diff part", () => {
  const part = {
    id: "call1",
    type: "tool_call",
    name: "patch",
    arguments: { mode: "patch", patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old line\n+new line\n*** End Patch" },
    status: "completed",
  } as never;
  const result = {
    type: "tool_result",
    toolCallId: "call1",
    returnCode: 0,
    content: [
      { type: "text", text: "PATCH APPLIED — replaced unique match in a.ts." },
      { type: "text", id: "file_diff", text: diffJson },
    ],
  } as never;
  const html = createToolInvocationCard(part as never, result as never).outerHTML;
  assert.match(html, /tool-file-line is-del/);
  assert.match(html, /tool-file-line is-add/);
  assert.match(html, /tool-file-diff/);
});

test("edit_file card falls back to old/new args diff without file_diff part", () => {
  const part = {
    id: "call2",
    type: "tool_call",
    name: "edit_file",
    arguments: { path: "/tmp/a.ts", old_string: "old line", new_string: "new line" },
    status: "completed",
  } as never;
  const result = {
    type: "tool_result",
    toolCallId: "call2",
    returnCode: 0,
    content: [{ type: "text", text: "Edited /tmp/a.ts" }],
  } as never;
  const html = createToolInvocationCard(part as never, result as never).outerHTML;
  assert.match(html, /tool-file-line is-del/);
  assert.match(html, /tool-file-line is-add/);
});

test("write_file card renders markdown for .md, numbered view for code", () => {
  const mk = (name: string, args: Record<string, unknown>) => ({
    id: "call3",
    type: "tool_call",
    name,
    arguments: args,
    status: "completed",
  });
  const mkResult = () => ({
    type: "tool_result",
    toolCallId: "call3",
    returnCode: 0,
    content: [{ type: "text", text: "done" }],
  });
  const md = createToolInvocationCard(
    mk("write_file", { path: "/tmp/b.md", content: "# Title" }) as never,
    mkResult() as never,
  ).outerHTML;
  assert.match(md, /content-card-write-markdown/);
  assert.match(md, /md-heading-1/);
  const codeCard = createToolInvocationCard(
    mk("write_file", { path: "/tmp/a.ts", content: "const x = 1;" }) as never,
    mkResult() as never,
  );
  const code = codeCard.outerHTML;
  assert.match(code, /tool-file-lines/);
  // Plain-text match against textContent — hljs token spans split raw HTML.
  assert.match(codeCard.textContent ?? "", /const x = 1;/);
  assert.match(code, /hljs-keyword/);
});

test("compact card (run_shell) is a single inert row", () => {
  const part = {
    id: "call4",
    type: "tool_call",
    name: "run_shell",
    arguments: { command: "ls" },
    status: "completed",
  } as never;
  const result = {
    type: "tool_result",
    toolCallId: "call4",
    returnCode: 0,
    content: [{ type: "text", text: "a\nb" }],
  } as never;
  const card = createToolInvocationCard(part as never, result as never);
  assert.equal((card as unknown as { tagName: string }).tagName, "DIV");
  assert.doesNotMatch(card.outerHTML, /tool-file-terminal|Arguments/);
});

test("exec_command (Windows shell) shows the command hint like run_shell", () => {
  for (const name of ["run_shell", "exec_command"]) {
    const part = {
      id: `sh-${name}`,
      type: "tool_call",
      name,
      arguments: { command: "npm run build" },
      status: "done",
    } as never;
    const result = {
      type: "tool_result",
      toolCallId: `sh-${name}`,
      returnCode: 0,
      content: [{ type: "text", text: "ok" }],
    } as never;
    const card = createToolInvocationCard(part as never, result as never);
    const hint = card.querySelector<HTMLElement>(".content-card-tool-result-hint");
    assert.equal(hint?.textContent, "npm run build", `${name} card carries the command hint`);

    // Running variant keeps the hint too (live card rendered at tool_call).
    const running = createToolInvocationCard({ ...part, status: "running" } as never, undefined);
    assert.equal(
      running.querySelector(".content-card-tool-result-hint")?.textContent,
      "npm run build",
      `${name} running card carries the command hint`,
    );
  }
});

test("long shell command hint is clipped with an ellipsis", () => {
  const part = {
    id: "sh-long",
    type: "tool_call",
    name: "exec_command",
    arguments: { command: "x".repeat(80) },
    status: "done",
  } as never;
  const result = {
    type: "tool_result",
    toolCallId: "sh-long",
    returnCode: 0,
    content: [{ type: "text", text: "ok" }],
  } as never;
  const hint = createToolInvocationCard(part as never, result as never)
    .querySelector(".content-card-tool-result-hint");
  assert.match(hint?.textContent ?? "", /^x{64}…$/);
});

test("running card shows a spinner, not a RUNNING label", () => {
  const part = {
    id: "call5",
    type: "tool_call",
    name: "run_shell",
    arguments: { command: "sleep 5" },
    status: "running",
  } as never;
  const card = createToolInvocationCard(part as never, undefined);
  const spinner = card.querySelector(".content-card-tool-run-spinner");
  assert.ok(spinner, "loader-circle spinner present on the summary row");
  assert.match(spinner!.querySelector("svg")?.outerHTML ?? "", /<svg/);
  assert.doesNotMatch(card.textContent ?? "", /Running/, "no RUNNING text label");
});

// ── persistent collapsed failed-Patch card ──────────────────────────

const PATCH_FAILURE_TEXT = [
  "PATCH FAILED — old_string not found in /tmp/a.ts.",
  "10| const before = true;",
  "11| const stale = true;",
  "12| const after = true;",
].join("\n");

function failedPatchPart(id: string) {
  return {
    id,
    type: "tool_call",
    name: "patch",
    arguments: { mode: "patch", patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch" },
    status: "done",
  } as never;
}

function failedPatchResult(id: string) {
  return {
    type: "tool_result",
    toolCallId: id,
    returnCode: 1,
    content: [{ type: "text", text: PATCH_FAILURE_TEXT }],
  } as never;
}

test("failed patch stays visible and collapsed with expandable diagnostics", () => {
  const card = createToolInvocationCard(failedPatchPart("pf1"), failedPatchResult("pf1"));
  assert.equal(card.tagName, "DETAILS");
  assert.ok(card.classList.contains("is-rich"));
  assert.ok(card.classList.contains("is-error"));
  assert.ok(!card.hasAttribute("open"), "failure starts collapsed");
  assert.ok(!card.classList.contains("is-dormant"));
  assert.ok(card.querySelector(".content-card-tool-result-chevron"));
  assert.match(card.querySelector("summary")?.textContent ?? "", /Failed · No changes applied/);
  assert.match(card.querySelector(".content-card-tool-invocation-body")?.textContent ?? "", /PATCH FAILED/);
});

test("successful patch keeps its normal rich expandable card", () => {
  const part = {
    id: "pf-ok",
    type: "tool_call",
    name: "patch",
    arguments: { mode: "patch", patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch" },
    status: "done",
  } as never;
  const result = {
    type: "tool_result",
    toolCallId: "pf-ok",
    returnCode: 0,
    content: [{ type: "text", text: "PATCH APPLIED — /tmp/a.ts" }],
  } as never;
  const card = createToolInvocationCard(part, result);
  assert.equal((card as unknown as { tagName: string }).tagName, "DETAILS");
  assert.ok(card.querySelector(".content-card-tool-invocation-body"));
});

test("history keeps a visible collapsed failed Patch between Thinking blocks", () => {
  const session = {
    id: "s1", status: "idle",
    messages: [
      { id: "m1", role: "assistant", createdAt: 1, parts: [{ type: "reasoning", text: "Before patch" }, failedPatchPart("pf2")] },
      { id: "m2", role: "tool", createdAt: 2, parts: [failedPatchResult("pf2")] },
      { id: "m3", role: "assistant", createdAt: 3, parts: [{ type: "reasoning", text: "Fix the ambiguous hunk" }] },
    ],
  } as never;
  const flow = renderChatStream(session);
  const items = [...flow.querySelectorAll<HTMLElement>('.conversation-reasoning, [data-tool-call-id]')];
  assert.equal(items.length, 3);
  assert.ok(items[0]!.classList.contains("conversation-reasoning"));
  assert.equal(items[1]!.dataset.toolCallId, "pf2");
  assert.ok(!items[1]!.classList.contains("is-dormant"));
  assert.ok(!items[1]!.hasAttribute("open"));
  assert.ok(items[2]!.classList.contains("conversation-reasoning"));
});

test("failed Patch stays visible after the live outcome hold", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const row = document.createElement("div");
    const card = createToolInvocationCard(failedPatchPart("pf3"), failedPatchResult("pf3"));
    row.append(card);
    document.body.replaceChildren(row);
    armLiveOutcomeFade(card);
    mock.timers.tick(6000);
    assert.equal(card.parentNode, row);
    assert.ok(!card.classList.contains("is-dormant"));
    assert.ok(!card.hasAttribute("open"));
  } finally {
    mock.timers.reset();
    document.body.replaceChildren();
  }
});

test("live failure closes its running preview and refresh preserves user expansion", async () => {
  const { ChatLiveStream } = await import("../src/chat.js");
  const flow = document.createElement("div");
  const scroller = document.createElement("div");
  document.body.append(flow, scroller);
  const live = new ChatLiveStream(flow, scroller);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    live.apply({ type: "tool_call", id: "pf4", name: "patch", arguments: { mode: "patch", patch: "..." } } as never);
    const preview = flow.querySelector<HTMLDetailsElement>('[data-tool-call-id="pf4"]')!;
    preview.open = true;
    const failedSession = {
      id: "s2", status: "running",
      messages: [
        { id: "m1", role: "assistant", createdAt: 1, parts: [failedPatchPart("pf4")] },
        { id: "m2", role: "tool", createdAt: 2, parts: [failedPatchResult("pf4")] },
      ],
    } as never;
    live.refreshToolCards(failedSession);
    let failed = flow.querySelector<HTMLDetailsElement>('[data-tool-call-id="pf4"]')!;
    assert.ok(!failed.hasAttribute("open"), "failure closes the preview");
    assert.ok(!failed.classList.contains("is-dormant"));
    failed.open = true;
    live.refreshToolCards(failedSession);
    failed = flow.querySelector<HTMLDetailsElement>('[data-tool-call-id="pf4"]')!;
    assert.equal(failed.open, true, "snapshot preserves user expansion");
    mock.timers.tick(6000);
    assert.equal(flow.querySelector('[data-tool-call-id="pf4"]'), failed, "failure card persists");
  } finally {
    mock.timers.reset();
    live.reset();
    flow.remove();
    scroller.remove();
  }
});

// ── ask_user live panel (web console interactivity) ──────────────────
test("ask_user card renders interactive panel from pendingAsk snapshot", () => {
  const part = {
    id: "ask1",
    type: "tool_call",
    name: "ask_user",
    arguments: { question: "Deploy now?", options: ["Yes", "No"] },
    status: "running",
  } as never;
  const answers: Array<{ requestId: string; selected: string; custom: boolean }> = [];
  const card = createToolInvocationCard(part as never, undefined, {
    pendingAsk: {
      requestId: "req-1",
      toolCallId: "ask1",
      question: "Deploy now?",
      options: ["Yes", "No"],
      allowCustom: true,
      allowMultiple: false,
    },
    onAnswerAsk: (requestId, answer) => answers.push({ requestId, selected: answer.selected, custom: answer.custom }),
  });
  assert.match(card.outerHTML, /content-card-ask-user/);
  const option = card.querySelector<HTMLInputElement>('[data-option="Yes"]');
  assert.ok(option, "option button rendered");
  option!.checked = true;
  option!.dispatchEvent(new dom.window.Event("change"));
  assert.equal(answers.length, 0, "selection waits for explicit confirmation");
  card.querySelector<HTMLButtonElement>(".content-card-ask-user-confirm")!.click();
  assert.deepEqual(answers, [{ requestId: "req-1", selected: "Yes", custom: false }]);
});

test("ask panel mounts in place on a streamed running card (attachPendingAsk)", async () => {
  const { ChatLiveStream } = await import("../src/chat.js");
  const flow = document.createElement("div");
  const scroller = document.createElement("div");
  const live = new ChatLiveStream(flow as never, scroller as never);
  const answers: Array<{ requestId: string; selected: string }> = [];
  live.setCallbacks({
    pendingAsk: null,
    onAnswerAsk: (requestId, answer) => answers.push({ requestId, selected: answer.selected }),
  });
  live.apply({
    type: "tool_call",
    id: "ask2",
    name: "ask_user",
    arguments: { question: "Continue?", options: ["Go", "Stop"] },
    status: "running",
  });
  const mounted = live.attachPendingAsk({
    requestId: "req-2",
    toolCallId: "ask2",
    question: "Continue?",
    options: ["Go", "Stop"],
    allowCustom: false,
    allowMultiple: false,
  });
  assert.equal(mounted, true);
  const card = flow.querySelector('[data-tool-call-id="ask2"]') as HTMLElement;
  assert.ok(card, "card present");
  assert.match(card.className, /is-asking/);
  const option = card.querySelector<HTMLInputElement>('[data-option="Stop"]');
  assert.ok(option, "panel option rendered");
  option!.checked = true;
  option!.dispatchEvent(new dom.window.Event("change"));
  assert.equal(answers.length, 0, "selection waits for explicit confirmation");
  card.querySelector<HTMLButtonElement>(".content-card-ask-user-confirm")!.click();
  assert.deepEqual(answers, [{ requestId: "req-2", selected: "Stop" }]);
  // Unknown toolCallId → false so the caller falls back to a snapshot reload.
  assert.equal(live.attachPendingAsk({
    requestId: "req-3",
    toolCallId: "missing",
    question: "?",
    options: [],
    allowCustom: false,
    allowMultiple: false,
  }), false);
});

// ── multi-step plan cards (planCards.ts port) ────────────────────────
test("create_plan renders the rich plan card with step statuses", () => {
  const planJson = JSON.stringify({
    createToolCallId: "pc1",
    id: "plan_pc1",
    title: "Deploy console",
    status: "active",
    createdAt: 1,
    updatedAt: 1,
    steps: [
      { id: "s1", title: "build", status: "completed" },
      { id: "s2", title: "upload", status: "in_progress" },
      { id: "s3", title: "verify", status: "pending" },
    ],
  });
  const session = {
    id: "sess1",
    status: "running",
    messages: [
      { id: "m1", role: "assistant", createdAt: 1, parts: [
        { type: "tool_call", id: "pc1", name: "create_plan", arguments: {
          title: "Deploy console",
          steps: [{ title: "build" }, { title: "upload" }, { title: "verify" }],
        }, status: "completed" },
      ] },
      { id: "m2", role: "tool", createdAt: 2, parts: [
        { type: "tool_result", toolCallId: "pc1", returnCode: 0, content: [
          { type: "text", text: `PLAN CREATED\nplan_json:${planJson}` },
        ] },
      ] },
      { id: "m3", role: "assistant", createdAt: 3, parts: [
        { type: "tool_call", id: "pu1", name: "update_plan", arguments: {
          steps: [{ id: "s1", status: "completed" }, { id: "s2", status: "in_progress" }],
        }, status: "completed" },
      ] },
    ],
  } as never;
  const flow = renderChatStream(session);
  const html = flow.outerHTML;
  // Rich create_plan card (activated via plan_json in the result payload).
  assert.match(html, /content-card-plan"/);
  assert.match(html, /content-card-plan-step is-completed/);
  assert.match(html, /content-card-plan-step is-in_progress/);
  assert.match(html, /content-card-plan-step-spinner/);
  assert.match(html, /1\/3 · In progress/);
  assert.match(html, /check-badge/);
  // update_plan does not get its own card — the plan card above carries progress.
  assert.doesNotMatch(html, /content-card-plan-tool/);
});

test("conversation column keeps allowlisted cards and drops the rest", () => {
  const session = {
    id: "sess1",
    status: "running",
    messages: [
      { id: "m1", role: "assistant", createdAt: 1, parts: [
        { type: "text", text: "Checking the tree." },
        { type: "tool_call", id: "sh1", name: "run_shell", arguments: { command: "ls" }, status: "completed" },
        { type: "tool_call", id: "rf1", name: "read_file", arguments: { path: "/tmp/a.txt" }, status: "completed" },
        { type: "tool_call", id: "wf1", name: "write_file", arguments: { path: "/tmp/a.txt", content: "x" }, status: "completed" },
        { type: "tool_call", id: "ak1", name: "ask_user", arguments: { question: "Ship it?", options: ["Yes", "No"] }, status: "running" },
        { type: "text", text: "Waiting on you." },
      ] },
    ],
  } as never;
  const flow = renderChatStream(session, {
    pendingAsk: { requestId: "r1", toolCallId: "ak1", question: "Ship it?", options: ["Yes", "No"], allowCustom: false, allowMultiple: false },
  });
  const html = flow.outerHTML;
  // Hidden tools never paint CARDS; their ids may appear inside the Thought
  // block's expandable record (data-tool-records / row titles) only.
  assert.ok(!flow.querySelector('.content-card-tool-invocation[data-tool-call-id="sh1"]'));
  assert.ok(!flow.querySelector('.content-card-tool-invocation[data-tool-call-id="rf1"]'));
  const texts = Array.from(flow.querySelectorAll(".message-part-text"), (node) => node.textContent ?? "").join("|");
  assert.match(texts, /Checking the tree/, "narration text stays in the column");
  const thought = flow.querySelector("[data-turn-reasoning='1']");
  assert.doesNotMatch(thought?.querySelector(".conversation-reasoning-cot")?.textContent ?? "", /Checking the tree/);
  assert.equal(thought?.querySelector<HTMLElement>(".conversation-reasoning-tools")?.hidden, true);
  // Structured records replace the plain hints list when present (V1).
  assert.match(
    thought?.getAttribute("data-tool-records") ?? "",
    /"hint":"Shell ls"[\s\S]*"hint":"Read File a\.txt"/,
  );
  const recordRows = Array.from(
    thought?.querySelectorAll(".conversation-reasoning-toollog-row") ?? [],
    (row) => row.querySelector(".conversation-reasoning-toollog-name")?.textContent
      + " " + row.querySelector(".conversation-reasoning-toollog-detail")?.textContent,
  );
  assert.deepEqual(recordRows, ["Shell ls", "Read File a.txt"], "hidden calls land in the Thought record");
  assert.match(html, /Ship it\?/);
  assert.match(html, /wf1/);
  assert.match(html, /Waiting on you/);
});

test("ChatLiveStream skips live tool_call events outside the allowlist", async () => {
  const { ChatLiveStream } = await import("../src/chat.js");
  // Same document as the cards: linkedom loops when nodes from two
  // documents are mixed under one parent.
  const flow = document.createElement("div");
  const scroller = document.createElement("div");
  document.body.append(flow, scroller);
  (globalThis as { window?: unknown }).window = globalThis;
  const live = new ChatLiveStream(flow as never, scroller as never);
  try {
  live.apply({ type: "text_delta", text: "Looking." } as never);
  await new Promise((resolve) => setTimeout(resolve, 220)); // 180ms render throttle
  live.apply({ type: "tool_call", id: "sh9", name: "run_shell", arguments: { command: "pwd" } } as never);
  live.apply({ type: "tool_call", id: "rf9", name: "read_file", arguments: { path: "/tmp/a.txt" } } as never);
  live.apply({ type: "tool_call", id: "wf9", name: "write_file", arguments: { path: "/tmp/a.txt", content: "x" } } as never);
  const html = flow.outerHTML;
  assert.ok(!flow.querySelector('.content-card-tool-invocation[data-tool-call-id="sh9"]'), "hidden shell paints no card");
  assert.ok(!flow.querySelector('.content-card-tool-invocation[data-tool-call-id="rf9"]'), "hidden read paints no card");
  const paintedText = (): string =>
    Array.from(flow.querySelectorAll(".message-part-text"), (node) => node.textContent ?? "").join("");
  assert.equal(paintedText(), "Looking.", "reply text paints immediately");
  assert.match(html, /wf9/);
  const block = flow.querySelector<HTMLElement>("[data-turn-reasoning='1']");
  assert.ok(block, "hidden tools open a Thinking block");
  const recordNames = () =>
    Array.from(
      block.querySelectorAll(".conversation-reasoning-toollog-row"),
      (row) => row.querySelector(".conversation-reasoning-toollog-name")?.textContent
        + " " + row.querySelector(".conversation-reasoning-toollog-detail")?.textContent,
    );
  assert.deepEqual(recordNames(), ["Shell pwd", "Read File a.txt"], "hidden calls tracked as records");
  live.apply({ type: "text_delta", text: "Done." } as never);
  live.finish();
  assert.equal(paintedText(), "Looking.Done.");
  assert.doesNotMatch(block.querySelector(".conversation-reasoning-cot")?.textContent ?? "", /Looking\./);
  } finally {
    live.reset();
  }
});

// ── image tool cards (display_image / generate_image / capture_app_window) ──

const tinyPngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

function imageToolResult(overrides: Record<string, unknown> = {}) {
  return {
    type: "tool_result",
    toolCallId: "img1",
    returnCode: 0,
    content: [
      { type: "text", text: "Displayed /tmp/shot.png" },
      {
        type: "attachment",
        kind: "image",
        uri: "file:///tmp/shot.png",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 1234,
        thumbnailBase64: tinyPngBase64,
        thumbnailMimeType: "image/jpeg",
        ...overrides,
      },
    ],
  } as never;
}

test("display_image renders an inline image card from the embedded preview", () => {
  const part = {
    id: "img1",
    type: "tool_call",
    name: "display_image",
    arguments: { path: "/tmp/shot.png" },
    status: "completed",
  } as never;
  const card = createToolInvocationCard(part as never, imageToolResult());
  const html = card.outerHTML;
  assert.match(html, /content-card-display-image/);
  assert.match(html, /<img[^>]+src="data:image\/jpeg;base64,/);
  assert.match(html, /alt="shot\.png"/);
  // Native download anchor (data URL + download attr), not Open/Reveal.
  assert.match(html, /<a[^>]*class="content-card-display-image-action"/);
  assert.match(html, /download="shot\.png"/);
  assert.doesNotMatch(html, /content-card-tool-invocation-body/);
});

test("capture_app_window renders collapsed with a summary row + hidden body", () => {
  const part = {
    id: "img1",
    type: "tool_call",
    name: "capture_app_window",
    arguments: { app_name: "Safari", output: "/tmp/window.png" },
    status: "completed",
  } as never;
  const card = createToolInvocationCard(part as never, imageToolResult());
  assert.equal(card.tagName, "DETAILS");
  assert.equal((card as unknown as { open: boolean }).open, false);
  const html = card.outerHTML;
  assert.match(html, /content-card-display-image-collapsible/);
  assert.match(html, /Capture App Window/);
  assert.match(html, /shot\.png/);
  assert.match(html, /content-card-display-image-summary-chevron/);
  assert.match(html, /<img[^>]+src="data:image\/jpeg;base64,/);
});

test("generate_image running renders the sized generating placeholder", () => {
  const part = {
    id: "gen1",
    type: "tool_call",
    name: "generate_image",
    arguments: { prompt: "a cat", size: "1024x1024" },
    status: "running",
  } as never;
  const card = createToolInvocationCard(part as never, undefined);
  const html = card.outerHTML;
  assert.match(html, /content-card-display-image-generating/);
  assert.match(html, /Generating image…/);
  assert.match(html, /1024x1024/);
  assert.match(html, /content-card-display-image-generating-spinner/);
});

test("generate_image finished renders the expanded image card", () => {
  const part = {
    id: "img1",
    type: "tool_call",
    name: "generate_image",
    arguments: { prompt: "a cat" },
    status: "completed",
  } as never;
  const card = createToolInvocationCard(part as never, imageToolResult());
  assert.equal(card.tagName, "ARTICLE");
  assert.match(card.outerHTML, /<img[^>]+src="data:image\/jpeg;base64,/);
});

test("image tools fall back to the generic compact card without a preview", () => {
  const part = {
    id: "img1",
    type: "tool_call",
    name: "display_image",
    arguments: { path: "/tmp/shot.png" },
    status: "completed",
  } as never;
  const result = {
    type: "tool_result",
    toolCallId: "img1",
    returnCode: 0,
    content: [
      { type: "text", text: "Displayed /tmp/shot.png" },
      {
        type: "attachment",
        kind: "image",
        uri: "file:///tmp/shot.png",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 1234,
      },
    ],
  } as never;
  const card = createToolInvocationCard(part as never, result);
  const html = card.outerHTML;
  // Older device builds / oversize sources: compact status row, no image.
  assert.match(html, /content-card-tool-invocation/);
  assert.match(html, /is-compact/);
  assert.doesNotMatch(html, /<img/);
  // Path hint surfaces the file the tool displayed.
  assert.match(html, /\/tmp\/shot\.png/);
});

test("image tools show an error card for failed results", () => {
  const part = {
    id: "img1",
    type: "tool_call",
    name: "display_image",
    arguments: { path: "/tmp/missing.png" },
    status: "error",
  } as never;
  const result = {
    type: "tool_result",
    toolCallId: "img1",
    returnCode: 3,
    content: [{ type: "text", text: "File not found: /tmp/missing.png" }],
  } as never;
  const card = createToolInvocationCard(part as never, result);
  const html = card.outerHTML;
  assert.match(html, /content-card-display-image-error/);
  assert.match(html, /File not found: \/tmp\/missing\.png/);
});

test("image tools without a result keep the generic running row", () => {
  const part = {
    id: "img1",
    type: "tool_call",
    name: "display_image",
    arguments: { path: "/tmp/shot.png" },
    status: "running",
  } as never;
  const card = createToolInvocationCard(part as never, undefined);
  const html = card.outerHTML;
  assert.match(html, /content-card-tool-invocation/);
  assert.doesNotMatch(html, /content-card-display-image/);
});
