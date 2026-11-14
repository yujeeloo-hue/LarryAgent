import assert from "node:assert/strict";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import type { Session } from "../../session/types.js";
import { configurePromptDefaults } from "../../settings/promptDefaults.js";
import { buildSystemPrefix } from "./buildSystemPrefix.js";

before(() => {
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
});

function makeSession(): Session {
  const now = Date.now();
  return {
    id: "prefix-sess",
    type: "agent",
    title: "Prefix",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    progressText: "",
    messages: [],
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

describe("persona override", () => {
  it("drops shared IDENTITY, swaps SOUL/AGENT and puts memory where PROJECT goes", () => {
    const session = { ...makeSession(), source: "coco_chat" as const, workspacePath: "/home/coco" };
    const prefix = buildSystemPrefix({ session, persona: { soul: "Coco soul", agent: "Coco agent at {{workspacePath}}", memory: { label: "COCO_MEMORY", body: "## Focus\n- x" } } });
    const bodies = prefix.map(m => String(m.content));
    assert.equal(bodies.some(b => b.startsWith("[IDENTITY]")), false);
    assert.equal(bodies.some(b => b.startsWith("[PROJECT]")), false);
    assert.ok(bodies.includes("[SOUL]\nCoco soul"));
    assert.ok(bodies.some(b => b.startsWith("[USER]")));
    assert.ok(bodies.includes("[COCO_MEMORY]\n## Focus\n- x"));
    assert.ok(bodies.some(b => b.startsWith("[AGENT]") && b.includes("Coco agent at /home/coco")));
    const order = ["[SOUL]", "[USER]", "[COCO_MEMORY]", "[AGENT]"].map(label => bodies.findIndex(b => b.startsWith(label)));
    assert.deepEqual([...order].sort((a, b) => a - b), order);
  });
});

function agentSlot(messages: { role: string; content: unknown }[]): string {
  const match = messages.find(
    (m) =>
      m.role === "system" &&
      typeof m.content === "string" &&
      (m.content.startsWith("[AGENT]") || m.content.startsWith("[SUBAGENT]")),
  );
  assert.ok(match, "expected AGENT or SUBAGENT system slot");
  return String(match.content);
}

function handoffSlot(messages: { role: string; content: unknown }[]): string {
  const match = messages.find(
    (m) =>
      m.role === "system" &&
      typeof m.content === "string" &&
      m.content.startsWith("[Turn handoff]"),
  );
  assert.ok(match, "expected [Turn handoff] system slot");
  return String(match.content);
}

describe("buildSystemPrefix", () => {
  it("keeps Bucket0 on AGENT.md for parent turns regardless of plan role", () => {
    const session = makeSession();
    const planner = buildSystemPrefix({ session, personaSlot: "agent" });
    const executor = buildSystemPrefix({ session, personaSlot: "agent" });
    const agent = buildSystemPrefix({ session, personaSlot: "agent" });

    const plannerSlot = agentSlot(planner);
    const executorSlot = agentSlot(executor);
    const agentSlotText = agentSlot(agent);

    assert.equal(plannerSlot, agentSlotText);
    assert.equal(executorSlot, agentSlotText);
    assert.match(plannerSlot, /^\[AGENT\]/);
    assert.doesNotMatch(plannerSlot, /\[PLANNER\]/);
    assert.doesNotMatch(executorSlot, /\[EXECUTOR\]/);
  });

  it("appends plan-role markdown after AGENT without replacing it", () => {
    const session = makeSession();
    const prefix = buildSystemPrefix({
      session,
      personaSlot: "agent",
      roleSystemPrompt: "[EXECUTOR]\nRun the plan.",
    });
    const slot = agentSlot(prefix);
    assert.match(slot, /^\[AGENT\]/);
    const role = prefix.find(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.startsWith("[EXECUTOR]"),
    );
    assert.ok(role, "expected [EXECUTOR] system message");
    const agentIndex = prefix.findIndex(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.startsWith("[AGENT]"),
    );
    const roleIndex = prefix.findIndex(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        m.content.startsWith("[EXECUTOR]"),
    );
    assert.ok(agentIndex >= 0 && roleIndex > agentIndex);
  });

  it("never injects a [Skills] catalog into Bucket0", () => {
    const session = makeSession();
    const prefix = buildSystemPrefix({
      session,
      personaSlot: "agent",
    });
    for (const msg of prefix) {
      assert.equal(
        typeof msg.content === "string" && msg.content.startsWith("[Skills]"),
        false,
      );
    }
  });

  it("keeps SUBAGENT.md in Bucket0 for child turns", () => {
    const session = makeSession();
    const prefix = buildSystemPrefix({
      session,
      personaSlot: "subagent",
    });
    const slot = agentSlot(prefix);
    assert.match(slot, /^\[SUBAGENT\]/);
    assert.doesNotMatch(slot, /\[AGENT\]/);
  });

  it("declares turn_handoff available when the session gate is on", () => {
    const session: Session = { ...makeSession(), handoffEnabled: true };
    for (const personaSlot of ["agent", "subagent"] as const) {
      const prefix = buildSystemPrefix({ session, personaSlot });
      const slot = handoffSlot(prefix);
      assert.match(slot, /turn_handoff is available for this session/);
      assert.doesNotMatch(slot, /handoff_disabled/);
    }
  });

  it("declares turn_handoff disabled when the session gate is off or unset", () => {
    const sessions: Session[] = [
      { ...makeSession(), handoffEnabled: false },
      { ...makeSession(), handoffEnabled: null },
      makeSession(),
    ];
    for (const session of sessions) {
      const prefix = buildSystemPrefix({ session, personaSlot: "agent" });
      const slot = handoffSlot(prefix);
      assert.match(slot, /turn_handoff is disabled for this session/);
      assert.match(slot, /handoff_disabled/);
      assert.doesNotMatch(slot, /available for this session/);
    }
  });
});
