/**
 * Demo-decision verbatim appendix (plan §7): confirmed present_demo params
 * must survive compaction byte-for-byte — rebuilt mechanically from the
 * transcript, deduped by toolCallId (latest wins), newest 20 kept (FIFO).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ContextCompactionPart,
  Message,
  MessagePart,
  Session,
} from "../../../../session/types.js";
import { buildDemoConfirmMessage } from "../../../../session/demoConfirm.js";
import { getCompactionStrategy } from "../../registry.js";
import type { CompactBeforeIterationInput } from "../../types.js";
import {
  buildDemoVerbatimAppendix,
  DEMO_VERBATIM_APPENDIX_HEADER,
  MAX_DEMO_VERBATIM_ENTRIES,
} from "./demoAppendix.js";
import { buildModelMessages } from "./messagesToOpenAi.js";

let idSeq = 0;

function nextId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${idSeq}`;
}

function user(text: string): Message {
  return {
    id: nextId("u"),
    role: "user",
    createdAt: idSeq,
    parts: [{ type: "text", text }],
  };
}

function assistant(parts: MessagePart[]): Message {
  return {
    id: nextId("a"),
    role: "assistant",
    createdAt: idSeq,
    parts,
  };
}

function demoToolCall(id: string, path: string, title?: string): Message {
  return assistant([
    {
      type: "tool_call",
      id,
      name: "present_demo",
      status: "done",
      arguments: { path, ...(title ? { title } : {}) },
      argumentsRaw: JSON.stringify({ path }),
    },
  ]);
}

describe("buildDemoVerbatimAppendix", () => {
  it("returns null with no confirmed demos", () => {
    const messages: Message[] = [
      user("Please make a layout demo"),
      demoToolCall("call_a", "/ws/demos/foo/index.html"),
    ];
    assert.equal(buildDemoVerbatimAppendix(messages), null);
  });

  it("includes title/path and the verbatim confirm text", () => {
    const confirmText = buildDemoConfirmMessage({
      toolCallId: "call_a",
      paramsJson: '{"height": 32, "accent": "#3b82f6"}',
      note: "denser",
    });
    const appendix = buildDemoVerbatimAppendix([
      demoToolCall("call_a", "/ws/demos/foo/index.html", "Layout demo"),
      user(confirmText),
    ])!;
    assert.ok(appendix.startsWith(DEMO_VERBATIM_APPENDIX_HEADER));
    assert.match(appendix, /## Layout demo — \/ws\/demos\/foo\/index\.html/);
    assert.ok(appendix.includes(confirmText));
  });

  it("falls back to the basename when no title is declared", () => {
    const confirmText = buildDemoConfirmMessage({
      toolCallId: "call_b",
      paramsJson: "{}",
    });
    const appendix = buildDemoVerbatimAppendix([
      demoToolCall("call_b", "/ws/demos/bar/index.html"),
      user(confirmText),
    ])!;
    assert.match(appendix, /## index\.html — \/ws\/demos\/bar\/index\.html/);
  });

  it("keeps only the latest confirmation per toolCallId", () => {
    const first = buildDemoConfirmMessage({
      toolCallId: "call_a",
      paramsJson: '{"height": 28}',
    });
    const second = buildDemoConfirmMessage({
      toolCallId: "call_a",
      paramsJson: '{"height": 44}',
    });
    const appendix = buildDemoVerbatimAppendix([
      demoToolCall("call_a", "/ws/demos/a/index.html"),
      user(first),
      user(second),
    ])!;
    assert.ok(appendix.includes(second));
    assert.ok(!appendix.includes(first));
    assert.equal(appendix.split("## ").length - 1, 1);
  });

  it("keeps the newest MAX entries (FIFO)", () => {
    const messages: Message[] = [];
    for (let i = 0; i < MAX_DEMO_VERBATIM_ENTRIES + 3; i += 1) {
      const callId = `call_${i}`;
      messages.push(demoToolCall(callId, `/ws/demos/d${i}/index.html`));
      messages.push(
        user(
          buildDemoConfirmMessage({
            toolCallId: callId,
            paramsJson: `{"n": ${1000 + i}}`,
          }),
        ),
      );
    }
    const appendix = buildDemoVerbatimAppendix(messages)!;
    // Oldest three dropped; boundary entry kept.
    assert.ok(!appendix.includes("demos/d0/"));
    assert.ok(!appendix.includes("demos/d2/"));
    assert.ok(appendix.includes("demos/d3/"));
    assert.ok(appendix.includes(`demos/d${MAX_DEMO_VERBATIM_ENTRIES + 2}/`));
    assert.equal(
      appendix.split("## ").length - 1,
      MAX_DEMO_VERBATIM_ENTRIES,
    );
  });

  it("parses markers with leading whitespace", () => {
    const confirmText = buildDemoConfirmMessage({
      toolCallId: "call_x",
      paramsJson: "{}",
    });
    const appendix = buildDemoVerbatimAppendix([
      demoToolCall("call_x", "/ws/demos/x/index.html"),
      user(`\n  ${confirmText}`),
    ])!;
    assert.ok(appendix.includes(confirmText));
  });
});

describe("compact flow attaches the verbatim appendix", () => {
  function makeSession(messages: Message[]): Session {
    const now = Date.now();
    return {
      id: "demo-appendix-sess",
      type: "agent",
      title: "Demo appendix test",
      createdAt: now,
      updatedAt: now,
      status: "completed",
      progressText: "",
      messages,
      model: "mock-model",
      providerId: "mock",
      workspaceId: "ws1",
      workspacePath: "",
      pinned: false,
      archived: false,
      archivedAt: null,
      contextUsage: { usedTokens: 0 },
      plan: null,
      planDoc: null,
    };
  }

  function makeInput(session: Session): CompactBeforeIterationInput {
    let id = 0;
    return {
      session,
      client: {
        baseUrl: "http://127.0.0.1:9",
        apiKey: "test-key",
        model: "mock-model",
      },
      createId: () => `c-${++id}`,
      contextLimitTokens: 1_000_000,
      summarize: async () => ({ content: "Summarized conversation." }),
      iterationProtectRawIterationCount: 0,
      iterationProtectTokenRatio: 0,
      force: true,
    };
  }

  it("part carries demoVerbatim and the model window shows it after the summary", async () => {
    const confirmText = buildDemoConfirmMessage({
      toolCallId: "call_demo",
      paramsJson: '{"height": 32, "accent": "#3b82f6"}',
      note: "denser",
    });
    const session = makeSession([
      user("Please make a layout demo"),
      demoToolCall("call_demo", "/ws/demos/layout/index.html", "Layout demo"),
      user(confirmText),
      assistant([{ type: "text", text: "Great, applying height 32." }]),
    ]);
    const input = makeInput(session);
    const result = await getCompactionStrategy(
      "iterationProtectV1",
    ).maybeCompactBeforeIteration(input);
    assert.equal(result.compacted, true);

    const marker = session.messages.find((m) =>
      m.parts.some((part) => part.type === "context_compaction"),
    );
    assert.ok(marker, "compaction marker exists");
    const part = marker!.parts.find(
      (p): p is ContextCompactionPart => p.type === "context_compaction",
    )!;
    assert.ok(part.demoVerbatim, "appendix attached to the part");
    assert.ok(part.demoVerbatim!.includes(confirmText));
    assert.ok(part.demoVerbatim!.startsWith(DEMO_VERBATIM_APPENDIX_HEADER));
    // LLM summary stays clean (appendix lives in its own field).
    assert.ok(!part.summary.includes(confirmText));

    const wire = buildModelMessages(session.messages);
    const sys = wire.find((m) => m.role === "system");
    assert.ok(sys, "system summary message exists");
    const content =
      typeof sys!.content === "string" ? sys!.content : String(sys!.content);
    assert.ok(content.includes("Summarized conversation."));
    assert.ok(content.includes(confirmText));
    assert.ok(
      content.indexOf("Summarized conversation.") <
        content.indexOf(confirmText),
      "appendix follows the summary",
    );
  });

  it("no appendix field when the transcript has no confirmed demos", async () => {
    const session = makeSession([
      user("Plain request"),
      assistant([{ type: "text", text: "Plain answer." }]),
    ]);
    const input = makeInput(session);
    const result = await getCompactionStrategy(
      "iterationProtectV1",
    ).maybeCompactBeforeIteration(input);
    assert.equal(result.compacted, true);
    const marker = session.messages.find((m) =>
      m.parts.some((part) => part.type === "context_compaction"),
    );
    const part = marker!.parts.find(
      (p): p is ContextCompactionPart => p.type === "context_compaction",
    )!;
    assert.equal(part.demoVerbatim, undefined);
  });
});
