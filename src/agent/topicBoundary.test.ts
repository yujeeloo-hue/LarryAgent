import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { Message, Session } from "../session/types.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import {
  applyNewTaskBoundary,
  judgeTopicBoundary,
  parseRelated,
  topicBoundaryMaterial,
  type TopicBoundaryJudgeInput,
} from "./topicBoundary.js";

const client: OpenAiCompatibleClientConfig = {
  baseUrl: "http://127.0.0.1:9",
  apiKey: "test-key",
  model: "mock-model",
};

let userDataDir = "";

before(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "topic-boundary-"));
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
});

after(async () => {
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

function user(id: string, text: string): Message {
  return { id, role: "user", parts: [{ type: "text", text }], createdAt: 1 };
}

function assistant(id: string, text: string): Message {
  return { id, role: "assistant", parts: [{ type: "text", text }], createdAt: 2 };
}

function makeSession(messages: Message[]): Session {
  return {
    id: "topic-session",
    type: "agent",
    title: "Topic",
    createdAt: 1,
    updatedAt: 1,
    status: "running",
    progressText: "",
    messages,
    model: "mock-model",
    providerId: "mock",
    workspaceId: "ws1",
    workspacePath: "",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 4_000, source: "provider" },
    plan: null,
    planDoc: null,
  };
}

function completeReturning(content: string): NonNullable<TopicBoundaryJudgeInput["complete"]> {
  return (async () => ({ content })) as unknown as NonNullable<
    TopicBoundaryJudgeInput["complete"]
  >;
}

describe("parseRelated", () => {
  it("accepts a bare object, prose-wrapped JSON, and string booleans", () => {
    assert.equal(parseRelated('{"related":true}'), true);
    assert.equal(parseRelated('Sure:\n{"related": false}\n'), false);
    assert.equal(parseRelated('{"related":"false"}'), false);
    assert.equal(parseRelated("not json"), null);
  });
});

describe("judgeTopicBoundary", () => {
  it("keeps context on the first prompt of a session", async () => {
    const session = makeSession([]);
    const decision = await judgeTopicBoundary({
      session,
      client,
      userText: "Build the settings screen",
      hasAttachments: false,
    });
    assert.equal(decision.split, false);
    assert.equal(decision.skipped, "no_prior_user_text");
  });

  it("keeps context while a plan is still active", async () => {
    const session = makeSession([user("u1", "Plan the refactor"), assistant("a1", "Ok")]);
    session.plan = {
      id: "plan-1",
      title: "Refactor",
      status: "active",
      steps: [{ id: "s1", title: "Step", status: "in_progress" }],
      createdAt: 1,
      updatedAt: 1,
      createToolCallId: "call-1",
    };
    const decision = await judgeTopicBoundary({
      session,
      client,
      userText: "Now rewrite the docs",
      hasAttachments: false,
      complete: completeReturning('{"related":false}'),
    });
    assert.equal(decision.split, false);
    assert.equal(decision.skipped, "active_plan");
  });

  it("splits when the model says the task changed", async () => {
    const session = makeSession([
      user("u1", "Fix the login bug"),
      assistant("a1", "Fixed in auth.ts"),
    ]);
    const decision = await judgeTopicBoundary({
      session,
      client,
      userText: "Write a haiku about autumn",
      hasAttachments: false,
      complete: completeReturning('{"related":false}'),
    });
    assert.equal(decision.split, true);
    assert.equal(decision.skipped, undefined);
  });

  it("keeps context when the model marks it related", async () => {
    const session = makeSession([
      user("u1", "Fix the login bug"),
      assistant("a1", "Fixed in auth.ts"),
    ]);
    const decision = await judgeTopicBoundary({
      session,
      client,
      userText: "Now add a test for it",
      hasAttachments: false,
      complete: completeReturning('{"related":true}'),
    });
    assert.equal(decision.split, false);
  });

  it("fails open on an unusable reply", async () => {
    const session = makeSession([user("u1", "A"), assistant("a1", "B")]);
    const decision = await judgeTopicBoundary({
      session,
      client,
      userText: "Something else",
      hasAttachments: false,
      complete: completeReturning("no json here"),
    });
    assert.equal(decision.split, false);
    assert.equal(decision.skipped, "failed");
  });

  it("fails open when the call throws", async () => {
    const session = makeSession([user("u1", "A"), assistant("a1", "B")]);
    const decision = await judgeTopicBoundary({
      session,
      client,
      userText: "Something else",
      hasAttachments: false,
      complete: (async () => {
        throw new Error("network down");
      }) as unknown as NonNullable<TopicBoundaryJudgeInput["complete"]>,
    });
    assert.equal(decision.split, false);
    assert.equal(decision.skipped, "failed");
  });

  it("ignores prompts above an existing boundary", async () => {
    const session = makeSession([
      user("u1", "Old task"),
      assistant("a1", "Done"),
      {
        id: "boundary",
        role: "system",
        createdAt: 3,
        parts: [
          {
            type: "context_new_task",
            id: "boundary-part",
            reason: "unrelated_prompt",
            hiddenMessageCount: 2,
          },
        ],
      },
    ]);
    const decision = await judgeTopicBoundary({
      session,
      client,
      userText: "First prompt of the new task",
      hasAttachments: false,
      complete: completeReturning('{"related":false}'),
    });
    assert.equal(decision.split, false);
    assert.equal(decision.skipped, "no_prior_user_text");
  });
});

describe("topicBoundaryMaterial", () => {
  it("uses only the last exchange inside the live window", () => {
    const material = topicBoundaryMaterial([
      user("u1", "Old request"),
      assistant("a1", "Old answer"),
      {
        id: "boundary",
        role: "system",
        createdAt: 3,
        parts: [
          {
            type: "context_new_task",
            id: "boundary-part",
            reason: "unrelated_prompt",
            hiddenMessageCount: 2,
          },
        ],
      },
      user("u2", "New request"),
      assistant("a2", "New answer"),
    ]);
    assert.equal(material.user, "New request");
    assert.equal(material.assistant, "New answer");
    assert.doesNotMatch(JSON.stringify(material), /Old request|Old answer/);
  });
});

describe("applyNewTaskBoundary", () => {
  it("writes the marker last and resets usage, buckets, phase, and plan doc", () => {
    const session = makeSession([user("u1", "A"), assistant("a1", "B")]);
    session.contextBuckets = {
      hotTurnCount: 4,
      warmTurnCount: 0,
      hot: 3,
      warm: 0,
      cold: 1,
      updatedAt: 1,
    };
    session.phase = "executing";
    session.fsmBlackboard = { phase: "executing", other: 1 };
    session.planDoc = { path: "docs/plans/x.md", summary: "Old", updatedAt: 1 };
    let seq = 0;
    const result = applyNewTaskBoundary({
      session,
      createId: () => `id-${++seq}`,
    });
    assert.equal(result.hiddenMessageCount, 2);
    assert.equal(session.messages.length, 3);
    const marker = session.messages.at(-1)!;
    assert.equal(marker.role, "system");
    assert.equal(marker.id, result.markerId);
    assert.deepEqual(marker.parts[0], {
      type: "context_new_task",
      id: "id-2",
      reason: "unrelated_prompt",
      hiddenMessageCount: 2,
    });
    assert.equal(session.planDoc, null);
    assert.equal(session.fsmBlackboard, null);
    assert.equal(session.phase, null);
    assert.equal(session.contextUsage.usedTokens, 0);
    assert.equal(session.contextBuckets?.cold, 0);
  });
});
