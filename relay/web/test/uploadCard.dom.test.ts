/**
 * DOM tests: upload_files tool card — Mac uploadCard parity on the web
 * console. Args detection (incl. deferred tool_call bridge unwrap),
 * tool_live payload narrowing + live-zone patching through ChatLiveStream,
 * finished transfer summary parsing (stats / file rows / error tail).
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

const {
  uploadInfoFromTool,
  uploadLiveFromPayload,
  parseUploadFinished,
  parseRsyncProgressLine,
} = await import("../src/uploadCard.js");
const {
  createToolInvocationCard,
} = await import("../src/toolCards.js");
const { ChatLiveStream, renderChatStream } = await import("../src/chat.js");
import type { Session, StreamEvent, ToolResultPart } from "../src/types.js";

const UPLOAD_ARGS = {
  src: "relay/public/",
  dest_host: "root@198.51.100.99",
  dest_path: "/opt/jellybot-relay/public/",
  excludes: [".env"],
};

const part = (over: Record<string, unknown> = {}) => ({
  type: "tool_call",
  id: "u1",
  name: "upload_files",
  status: "running",
  arguments: { ...UPLOAD_ARGS },
  argumentsRaw: "",
  ...over,
}) as Parameters<typeof createToolInvocationCard>[0];

const result = (text: string, returnCode = 0) => ({
  type: "tool_result",
  toolCallId: "u1",
  returnCode,
  executionSummary: "ok",
  content: [{ type: "text", text }],
}) as unknown as ToolResultPart;

const FINISHED_OUTPUT = [
  "--- stdout ---",
  "          1,234,567  98%  12.30MB/s    0:00:01 (xfr#12, to-chk=0/48)",
  "44,878,387 100%  4.90MB/s    0:00:09 (xfr#214, to-chk=0/2589)",
  "assets/index-ABC.js|78525|262286",
  "assets/index-DEF.css|15538|82776",
  "index.html|242|1095",
  "elapsed 3.4s",
  "--- stderr ---",
].join("\n");

test("uploadInfoFromTool detects structured args and rejects junk", () => {
  const info = uploadInfoFromTool("upload_files", UPLOAD_ARGS)!;
  assert.equal(info.src, "relay/public/");
  assert.equal(info.dest, "root@198.51.100.99:/opt/jellybot-relay/public/");
  assert.deepEqual(info.excludes, [".env"]);
  assert.equal(uploadInfoFromTool("run_shell", UPLOAD_ARGS), null, "other tools are null");
  assert.equal(uploadInfoFromTool("upload_files", { src: "a" }), null, "missing dest fields");
  assert.equal(uploadInfoFromTool("upload_files", null), null);
});

test("uploadLiveFromPayload narrows live snapshots and rejects junk", () => {
  const state = uploadLiveFromPayload({
    phase: "transferring",
    src: "relay/public/",
    dest: "h:/p",
    percent: 42.5,
    bytesSent: 1000,
    bytesTotal: 4000,
    speed: "12.30MB/s",
    etaSeconds: 9,
    filesDone: 12,
    filesTotal: 48,
    recentFiles: [
      { name: "a.js", bytes: 10 },
      { junk: true },
      "nope",
      { name: "b.css", bytes: 20 },
    ],
  })!;
  assert.equal(state.phase, "transferring");
  assert.equal(state.percent, 42.5);
  assert.deepEqual(
    state.recentFiles.map((f) => f.name),
    ["a.js", "b.css"],
    "junk rows dropped",
  );
  assert.equal(uploadLiveFromPayload("nope"), null);
  assert.equal(uploadLiveFromPayload(null), null);
  // Unknown phase degrades to connecting, not a crash.
  assert.equal(uploadLiveFromPayload({ phase: "weird" })!.phase, "connecting");
});

test("parseRsyncProgressLine parses progress2 snapshots", () => {
  const s = parseRsyncProgressLine("44,878,387 100%  4.90MB/s    0:00:09 (xfr#214, to-chk=0/2589)")!;
  assert.equal(s.bytesSent, 44878387);
  assert.equal(s.percent, 100);
  assert.equal(s.filesTransferred, 214);
  assert.equal(s.etaSeconds, 9);
  assert.equal(parseRsyncProgressLine("index.js|1234|4321"), null);
});

test("parseUploadFinished distills stats + file lines from rsync output", () => {
  const stats = parseUploadFinished(FINISHED_OUTPUT);
  assert.equal(stats.files, 214, "xfr# wins over counted lines");
  assert.equal(stats.bytes, 44878387, "last progress2 line");
  assert.equal(stats.elapsedSec, 3.4);
  assert.deepEqual(
    stats.fileLines.map((f) => f.name),
    ["assets/index-ABC.js", "assets/index-DEF.css", "index.html"],
  );
  assert.deepEqual(stats.stderrTail, [], "no stderr lines");
});

test("running upload card: compact row + seeded live zone + src→dest hint", () => {
  const card = createToolInvocationCard(part(), undefined);
  assert.equal(card.tagName, "DIV", "running stays compact (non-expandable)");
  assert.ok(card.classList.contains("content-card-tool-upload"));
  const zone = card.querySelector<HTMLElement>(".content-card-tool-upload-zone")!;
  assert.ok(zone, "live progress zone attached");
  assert.equal(
    zone.querySelector('[data-role="rest"]')!.textContent,
    "Connecting to remote…",
    "seeded connecting phase",
  );
  const hint = card.querySelector<HTMLElement>(".content-card-tool-result-hint")!;
  assert.match(hint.textContent ?? "", /^relay\/public\/ → root@198\.51\.100\.99:/);
});

test("deferred tool_call bridge unwraps to the inner upload card", () => {
  const card = createToolInvocationCard(part({
    name: "tool_call",
    arguments: { name: "upload_files", arguments: { ...UPLOAD_ARGS } },
  }), undefined);
  assert.equal(card.dataset.toolName, "upload_files");
  assert.ok(card.classList.contains("content-card-tool-upload"));
  assert.ok(card.querySelector(".content-card-tool-upload-zone"));
});

test("finished upload card: rich, expanded, transfer summary replaces the output body", () => {
  const card = createToolInvocationCard(part({ status: "done" }), result(FINISHED_OUTPUT));
  assert.equal(card.tagName, "DETAILS", "finished becomes rich");
  // (details.open is only set through `instanceof HTMLDetailsElement`, which
  // the linkedom stub cannot satisfy — expand behavior is asserted on the
  // browser side; see the uploadFinished branch in toolCards.ts.)
  const section = card.querySelector(".content-card-tool-upload-section")!;
  assert.ok(section, "upload finished section");
  const stats = [...section.querySelectorAll(".content-card-tool-upload-stat b")].map(
    (b) => b.textContent,
  );
  assert.deepEqual(stats, ["214", "44.9 MB", "3.4s", "13.2 MB/s"]);
  assert.ok(section.querySelector(".content-card-tool-upload-excludes")!.textContent!.includes(".env"));
  const rows = [...section.querySelectorAll(".content-card-tool-upload-file-row")];
  assert.equal(rows.length, 3);
  assert.ok(rows[0].querySelector(".content-card-tool-upload-file-icon.is-done"), "check badge rows");
  const badge = rows[0].querySelector(".content-card-tool-upload-file-icon.is-done")!;
  assert.ok(badge.classList.contains("check-badge"), "green disc badge (Mac checkBadge parity)");
  assert.match(badge.querySelector("svg")!.getAttribute("stroke-width") ?? "", /^3\.25$/);
  assert.equal(rows[0].querySelector(".content-card-tool-upload-file-size")!.textContent, "262.3 KB");
  // Generic run output body (Arguments / terminal dump) never renders.
  assert.equal(card.querySelector(".content-card-tool-result-body"), null);
});

test("failed upload card: error title + stderr tail + resume hint", () => {
  const text = ["--- stdout ---", "elapsed 0.4s", "--- stderr ---", "rsync: link_stat failed", "rsync: error: some files"].join("\n");
  const card = createToolInvocationCard(part({ status: "error" }), result(text, 23));
  assert.ok(card.classList.contains("is-error"));
  assert.equal(card.querySelector(".content-card-tool-upload-err-title")!.textContent, "Upload failed");
  assert.match(
    card.querySelector(".content-card-tool-upload-err-stderr")!.textContent ?? "",
    /link_stat/,
  );
  assert.ok(card.querySelector(".content-card-tool-upload-err-hint"));
});

function live(): { stream: InstanceType<typeof ChatLiveStream>; flow: HTMLElement } {
  const flow = document.createElement("div");
  const scroller = document.createElement("div");
  scroller.append(flow);
  document.body.append(scroller);
  return { stream: new ChatLiveStream(flow, scroller), flow };
}

test("tool_live upload snapshots patch the running card's zone in place", () => {
  const { stream, flow } = live();
  stream.apply({
    type: "tool_call",
    id: "u1",
    name: "upload_files",
    arguments: { ...UPLOAD_ARGS },
    argumentsRaw: "",
  } as StreamEvent);

  const zone = flow.querySelector<HTMLElement>(".content-card-tool-upload-zone")!;
  assert.equal(zone.querySelector('[data-role="rest"]')!.textContent, "Connecting to remote…");

  stream.apply({
    type: "tool_live",
    toolCallId: "u1",
    kind: "upload",
    payload: {
      phase: "transferring",
      src: "relay/public/",
      dest: "h:/p",
      percent: 37.4,
      bytesSent: 1000,
      bytesTotal: 4000,
      speed: "1.20MB/s",
      etaSeconds: 5,
      filesDone: 3,
      filesTotal: 9,
      recentFiles: [{ name: "index.html", bytes: 1095 }],
    },
  } as StreamEvent);

  assert.equal(zone.querySelector('[data-role="pct"]')!.textContent, "37%");
  assert.equal(zone.querySelector('[data-role="rest"]')!.textContent, "1.0 KB / 4.0 KB");
  assert.equal(zone.querySelector('[data-role="meta"]')!.textContent, "1.20MB/s · ETA 5s · 3/9 files");
  assert.equal(
    zone.querySelector(".content-card-tool-upload-file-row .content-card-tool-upload-file-name")!.textContent,
    "index.html",
  );
  // Fill width follows the snapshot; indeterminate clears once transferring.
  const fill = zone.querySelector<HTMLElement>('[data-role="fill"]')!;
  assert.equal(fill.style.width, "37.4%");
  assert.ok(!fill.classList.contains("is-indeterminate"));

  // Zone is patched in place — the card is never rebuilt mid-run.
  const card = flow.querySelector(".content-card-tool-invocation")!;
  stream.apply({
    type: "tool_live",
    toolCallId: "u1",
    kind: "upload",
    payload: { phase: "transferring", percent: 60, recentFiles: [{ name: "index.html", bytes: 1095 }, { name: "a.css", bytes: 20 }] },
  } as StreamEvent);
  assert.equal(flow.querySelector(".content-card-tool-invocation"), card, "same card node");
  assert.equal(zone.querySelector('[data-role="pct"]')!.textContent, "60%");
  assert.equal(zone.dataset.fileCount, "2");

  // Unknown toolCallId / junk payload: silently ignored.
  stream.apply({ type: "tool_live", toolCallId: "nope", kind: "upload", payload: { phase: "transferring" } } as StreamEvent);
  stream.apply({ type: "tool_live", toolCallId: "u1", kind: "other", payload: {} } as StreamEvent);
  assert.equal(zone.querySelector('[data-role="pct"]')!.textContent, "60%");
});

test("snapshot render: hidden 'tool_call' bridge wrapper still shows the inner upload card", () => {
  // Real-world shape (session DB): uploads ride the deferred tool_call bridge
  // and toolDisplayOverrides hides the wrapper name "tool_call". The hidden
  // check must run on the INNER tool name (Mac MessageView parity) or the
  // upload card never renders on the web console.
  const session = {
    id: "s1",
    title: "deploy",
    createdAt: 0,
    updatedAt: 0,
    status: "idle",
    messages: [
      {
        id: "m1",
        role: "assistant",
        createdAt: 0,
        parts: [
          { type: "reasoning", text: "" },
          {
            type: "tool_call",
            id: "call_x1",
            name: "tool_call",
            status: "done",
            arguments: { name: "upload_files", arguments: { ...UPLOAD_ARGS } },
            argumentsRaw: "",
          },
        ],
      },
      {
        id: "m2",
        role: "tool",
        createdAt: 0,
        parts: [{ type: "tool_result", toolCallId: "call_x1", returnCode: 0, content: [{ type: "text", text: FINISHED_OUTPUT }] }],
      },
    ],
  } as unknown as Session;

  const flow = renderChatStream(session);
  const card = flow.querySelector<HTMLElement>(".content-card-tool-invocation")!;
  assert.ok(card, "upload card renders despite hidden 'tool_call' wrapper");
  assert.equal(card.dataset.toolName, "upload_files");
  assert.ok(card.classList.contains("content-card-tool-upload"));
  assert.ok(card.querySelector(".content-card-tool-upload-section"), "finished summary present");
});

test("empty reasoning around a tool call never renders a Thinking card", () => {
  // Providers (GLM / kimi) open tool-call turns with an empty reasoning
  // chunk; both the live stream and the snapshot render must skip it —
  // only the upload card remains.
  const { stream, flow } = live();
  stream.apply({ type: "reasoning_delta", messageId: "m1", text: "" } as StreamEvent);
  stream.apply({
    type: "tool_call",
    id: "u1",
    name: "upload_files",
    arguments: { ...UPLOAD_ARGS },
    argumentsRaw: "",
  } as StreamEvent);
  stream.finish();
  assert.equal(flow.querySelector(".conversation-reasoning"), null, "live: no empty Thinking block");
  assert.ok(flow.querySelector(".content-card-tool-upload"), "live: upload card present");

  // Whitespace-only CoT collapses to nothing at finalize.
  stream.apply({ type: "reasoning_delta", messageId: "m2", text: "   \n  " } as StreamEvent);
  assert.ok(flow.querySelector(".conversation-reasoning"), "whitespace block materialized live");
  stream.finish();
  assert.equal(flow.querySelector(".conversation-reasoning"), null, "finalized away");

  // Snapshot: assistant message with an empty reasoning part + the bridge
  // tool_call renders only the card (Mac MessageView parity).
  const session = {
    id: "s2",
    title: "t",
    createdAt: 0,
    updatedAt: 0,
    status: "idle",
    messages: [
      {
        id: "m3",
        role: "assistant",
        createdAt: 0,
        parts: [
          { type: "reasoning", text: "" },
          {
            type: "tool_call",
            id: "call_y1",
            name: "tool_call",
            status: "done",
            arguments: { name: "upload_files", arguments: { ...UPLOAD_ARGS } },
            argumentsRaw: "",
          },
        ],
      },
      {
        id: "m4",
        role: "tool",
        createdAt: 0,
        parts: [{ type: "tool_result", toolCallId: "call_y1", returnCode: 0, content: [{ type: "text", text: FINISHED_OUTPUT }] }],
      },
    ],
  } as unknown as Session;
  const snap = renderChatStream(session);
  assert.equal(snap.querySelectorAll(".conversation-reasoning").length, 0, "snapshot: no empty Thinking block");
  assert.ok(snap.querySelector(".content-card-tool-upload"), "snapshot: upload card present");
});
