import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AttachmentDraft } from "../agent/ipcTypes.js";
import {
  rollbackCancelledTurnPrompt,
  type PromptRestorePayload,
} from "./cancelRollback.js";
import type {
  AssistantMessage,
  Message,
  Session,
  UserMessage,
} from "../session/types.js";
import { buildDemoConfirmMessage } from "../session/demoConfirm.js";
import { RETRY_CONTINUATION_PART_ID } from "../session/types.js";

function user(parts: Message["parts"]): UserMessage {
  return { id: "u1", role: "user", createdAt: 1, parts };
}

function emptyAssistant(): AssistantMessage {
  return { id: "a1", role: "assistant", createdAt: 2, parts: [] };
}

function assistant(parts: Message["parts"]): AssistantMessage {
  return { id: "a1", role: "assistant", createdAt: 2, parts };
}

function session(messages: Message[]): Session {
  return {
    id: "s1",
    messages,
  } as unknown as Session;
}

const alwaysExists = (): true => true;

function run(
  messages: Message[],
  turnStartIndex: number,
  options?: {
    aborted?: boolean;
    fallback?: { text: string; attachments: AttachmentDraft[] } | null;
  },
): PromptRestorePayload | null {
  const s = session(messages);
  const result = rollbackCancelledTurnPrompt({
    session: s,
    turnStartIndex,
    aborted: options?.aborted ?? true,
    fallback: options?.fallback ?? null,
    fileExists: alwaysExists,
  });
  // Mutation must only happen when a payload is returned.
  if (!result) {
    assert.deepEqual(s.messages, messages);
  }
  return result;
}

describe("rollbackCancelledTurnPrompt", () => {
  it("rolls back prompt + empty assistant placeholder", () => {
    const history = [user([{ type: "text", text: "earlier" }])];
    const messages: Message[] = [
      ...history,
      user([{ type: "text", text: "stop me" }]),
      emptyAssistant(),
    ];
    const result = run(messages, 1);
    assert.ok(result);
    assert.equal(result.text, "stop me");
    assert.deepEqual(result.attachments, []);
    assert.equal(messages.length, 1);
    assert.equal(messages[0], history[0]);
  });

  it("keeps a demo-confirm turn in the transcript on STOP (no restore)", () => {
    const history = [user([{ type: "text", text: "earlier" }])];
    const messages: Message[] = [
      ...history,
      user([{
        type: "text",
        text: buildDemoConfirmMessage({
          toolCallId: "call_x",
          paramsJson: '{"n": 2}',
        }),
      }]),
      emptyAssistant(),
    ];
    const result = run(messages, 1);
    assert.equal(result, null);
    assert.equal(messages.length, 3);
  });

  it("keeps a hidden retry-continuation turn on STOP — its synthetic prompt never reaches the composer", () => {
    const history = [user([{ type: "text", text: "earlier" }])];
    const continuation = user([
      {
        type: "text",
        text: "The previous turn was interrupted by an error before the task finished…",
        id: RETRY_CONTINUATION_PART_ID,
      },
    ]);
    const messages: Message[] = [...history, continuation, emptyAssistant()];
    const result = run(messages, 1);
    assert.equal(result, null);
    assert.equal(messages.length, 3);
    // No fallback restore either, even before any assistant placeholder
    // landed (the caller passes none for continuation turns).
    const bare = run([...history, continuation], 1);
    assert.equal(bare, null);
    assert.equal(messages.length, 3);
  });

  it("rolls back a prompt-only turn (no assistant yet)", () => {
    const messages = [user([{ type: "text", text: "quick" }])];
    const result = run(messages, 0);
    assert.ok(result);
    assert.equal(result.text, "quick");
    assert.equal(messages.length, 0);
  });

  it("keeps whitespace-text assistant as rollback-eligible", () => {
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([{ type: "text", text: "   " }]),
    ];
    const result = run(messages, 0);
    assert.ok(result);
    assert.equal(messages.length, 0);
  });

  it("blocks rollback once real text arrived", () => {
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([{ type: "text", text: "partial" }]),
    ];
    assert.equal(run(messages, 0), null);
  });

  it("rolls back a thinking-only assistant (reasoning is not content)", () => {
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([
        { type: "reasoning", text: "hmm", durationMs: 120, tokenCount: 1 },
      ]),
    ];
    const result = run(messages, 0);
    assert.ok(result);
    assert.equal(result.text, "x");
    assert.equal(messages.length, 0);
  });

  it("rolls back reasoning mixed with whitespace text", () => {
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([
        { type: "reasoning", text: "thinking…" },
        { type: "text", text: "  \n " },
      ]),
    ];
    const result = run(messages, 0);
    assert.ok(result);
    assert.equal(messages.length, 0);
  });

  it("rolls back multiple thinking-only assistant messages", () => {
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([{ type: "reasoning", text: "round one" }]),
      assistant([{ type: "reasoning", text: "" }]),
    ];
    const result = run(messages, 0);
    assert.ok(result);
    assert.equal(messages.length, 0);
  });

  it("rolls back a Responses turn stopped after submit, before content", () => {
    // Realistic abort shape for Responses-protocol providers (GLM/Kimi):
    // the first response_state event pushes the native state echo onto the
    // assistant placeholder the moment the round submits — long before any
    // visible text. Stop there must still restore the prompt.
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([
        {
          type: "model_response",
          providerScope: "scope",
          responseId: "resp_1",
          status: "in_progress",
          stored: true,
          output: [],
        },
        { type: "reasoning", text: "thinking…", durationMs: 300 },
      ]),
    ];
    const result = run(messages, 0);
    assert.ok(result);
    assert.equal(result.text, "x");
    assert.equal(messages.length, 0);
  });

  it("blocks rollback when the Responses output materialized visible text", () => {
    // applyResponsesOutput lands visible native text as a text part —
    // that still counts as content even with the model_response whitelist.
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([
        {
          type: "model_response",
          providerScope: "scope",
          responseId: "resp_1",
          status: "completed",
          stored: true,
          output: [],
        },
        { type: "text", text: "partial answer" },
      ]),
    ];
    assert.equal(run(messages, 0), null);
  });

  it("blocks rollback when the Responses output materialized a hosted tool", () => {
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([
        {
          type: "model_response",
          providerScope: "scope",
          responseId: "resp_1",
          status: "completed",
          stored: true,
          output: [],
        },
        {
          type: "hosted_tool",
          id: "ws_1",
          name: "web_search",
          status: "incomplete",
        },
      ]),
    ];
    assert.equal(run(messages, 0), null);
  });

  it("blocks rollback when reasoning is followed by real text", () => {
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([
        { type: "reasoning", text: "hmm" },
        { type: "text", text: "partial" },
      ]),
    ];
    assert.equal(run(messages, 0), null);
  });

  it("blocks rollback when a later assistant message has text", () => {
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([{ type: "reasoning", text: "hmm" }]),
      assistant([{ type: "text", text: "visible" }]),
    ];
    assert.equal(run(messages, 0), null);
  });

  it("blocks rollback once a tool call arrived", () => {
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      assistant([
        {
          type: "tool_call",
          id: "t1",
          name: "read_file",
          status: "running",
          arguments: {},
          argumentsRaw: "{}",
        },
      ]),
    ];
    assert.equal(run(messages, 0), null);
  });

  it("blocks rollback when a steer message landed after the prompt", () => {
    const steer: UserMessage = {
      id: "u2",
      role: "user",
      createdAt: 3,
      parts: [
        { type: "text", text: "steer" },
        // steer-continuation marker: a text part carrying the marker id
        {
          type: "text",
          text: "steer",
          id: "steer-cont-u2",
        },
      ],
    };
    const messages: Message[] = [
      user([{ type: "text", text: "x" }]),
      emptyAssistant(),
      steer,
    ];
    // Any user message after the prompt blocks shape A regardless of marker.
    assert.equal(run(messages, 0), null);
  });

  it("no rollback without the user abort", () => {
    const messages = [user([{ type: "text", text: "x" }]), emptyAssistant()];
    assert.equal(run(messages, 0, { aborted: false }), null);
  });

  it("restores attachments that still exist and drops missing files", () => {
    const messages: Message[] = [
      user([
        { type: "text", text: "see files" },
        {
          type: "attachment",
          kind: "file",
          uri: "/tmp/exists.txt",
          mimeType: "text/plain",
          name: "exists.txt",
          sizeBytes: 3,
        },
        {
          type: "attachment",
          kind: "file",
          uri: "/tmp/gone.txt",
          mimeType: "text/plain",
        },
      ]),
    ];
    const s = session(messages);
    const result = rollbackCancelledTurnPrompt({
      session: s,
      turnStartIndex: 0,
      aborted: true,
      fileExists: (p) => p === "/tmp/exists.txt",
    });
    assert.ok(result);
    assert.deepEqual(result.attachments, [
      {
        path: "/tmp/exists.txt",
        name: "exists.txt",
        kind: "file",
        mimeType: "text/plain",
        sizeBytes: 3,
      },
    ]);
    assert.equal(messages.length, 0);
  });

  it("name falls back to the uri basename", () => {
    const messages: Message[] = [
      user([
        {
          type: "attachment",
          kind: "image",
          uri: "/tmp/dir/shot.png",
          mimeType: "image/png",
        },
      ]),
    ];
    const result = run(messages, 0);
    assert.ok(result);
    assert.equal(result.attachments[0]?.name, "shot.png");
  });

  it("shape B: stop before the prompt landed truncates error notes", () => {
    const history = [user([{ type: "text", text: "earlier" }])];
    const messages: Message[] = [
      ...history,
      {
        id: "e1",
        role: "system",
        createdAt: 2,
        parts: [{ type: "text", text: "This operation was aborted" }],
      },
    ];
    const result = run(messages, 1, {
      fallback: { text: " upload stop ", attachments: [] },
    });
    assert.ok(result);
    assert.equal(result.text, "upload stop");
    assert.equal(messages.length, 1);
    assert.equal(messages[0], history[0]);
  });

  it("shape B: nothing landed still restores from the fallback", () => {
    const history = [user([{ type: "text", text: "earlier" }])];
    const messages = [...history];
    const result = run(messages, 1, {
      fallback: { text: "stop during upload", attachments: [] },
    });
    assert.ok(result);
    assert.equal(result.text, "stop during upload");
    assert.equal(messages.length, 1);
  });

  it("shape B: non-system slice (orphan seals) blocks rollback", () => {
    const history = [user([{ type: "text", text: "earlier" }])];
    const messages: Message[] = [
      ...history,
      {
        id: "t1",
        role: "tool",
        toolCallId: "c1",
        createdAt: 2,
        parts: [
          {
            type: "tool_result",
            toolCallId: "c1",
            content: [{ type: "text", text: "Cancelled" }],
            returnCode: 6,
          },
        ],
      },
    ];
    assert.equal(
      run(messages, 1, {
        fallback: { text: "x", attachments: [] },
      }),
      null,
    );
  });

  it("shape B without a fallback never mutates", () => {
    const messages: Message[] = [
      {
        id: "e1",
        role: "system",
        createdAt: 2,
        parts: [{ type: "text", text: "aborted" }],
      },
    ];
    assert.equal(run(messages, 0, { fallback: null }), null);
  });

  it("shape B with an empty fallback (resume/handoff turn) never mutates", () => {
    const messages: Message[] = [
      {
        id: "e1",
        role: "system",
        createdAt: 2,
        parts: [{ type: "text", text: "aborted" }],
      },
    ];
    assert.equal(
      run(messages, 0, { fallback: { text: "   ", attachments: [] } }),
      null,
    );
    assert.equal(messages.length, 1);
  });

  it("out-of-range turnStartIndex is rejected", () => {
    assert.equal(run([user([{ type: "text", text: "x" }])], 5), null);
    assert.equal(run([user([{ type: "text", text: "x" }])], -1), null);
  });
});
