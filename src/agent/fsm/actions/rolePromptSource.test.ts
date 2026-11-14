/**
 * Role prompt dual-source (file / inline, pure replacement) —
 * helper + PrepareRole / PromptInject coverage.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, after, describe, it } from "node:test";
import type { Session } from "../../../session/types.js";
import type { RunAgentTurnInput, StreamChatFn } from "../../types.js";
import { PlanFacade } from "../../roles/PlanFacade.js";
import { createTurnState } from "../../roles/types.js";
import { createUniformRoleLlmBundle } from "../../roles/llmBinding.js";
import {
  configurePromptDefaults,
  getDefaultPlannerSystemPrompt,
  getDefaultSubagentSystemPrompt,
} from "../../../settings/promptDefaults.js";
import { displayPath } from "../../../tools/pathUtil.js";
import type { PrepareModelWindowInput } from "../../turnHost/types.js";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import { FSMConfigError } from "../FSMConfigError.js";
import { NodeActionBuildModelWindow } from "./NodeActionBuildModelWindow.js";
import { NodeActionPrepareRole } from "./NodeActionPrepareRole.js";
import { rolePresetParams } from "../configs/rolePresets.js";
import { NodeActionPromptInject } from "./NodeActionPromptInject.js";
import { resolvePromptOverride } from "./rolePromptSource.js";

let testDir = "";

before(async () => {
  testDir = await mkdtemp(join(tmpdir(), "role-prompt-"));
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
});

after(async () => {
  if (testDir) {
    await rm(testDir, { recursive: true, force: true });
  }
});

function makeSession(workspacePath: string): Session {
  const now = Date.now();
  return {
    id: "role-prompt-sess",
    type: "agent",
    title: "Role prompt test",
    createdAt: now,
    updatedAt: now,
    status: "idle",
    progressText: "",
    messages: [],
    model: "mock-model",
    providerId: "mock",
    workspaceId: "ws1",
    workspacePath,
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
    planDoc: null,
  } as Session;
}

/** Minimal turnScope for scopeOf / roleContextOf (plan null-safe). */
function makeTurnScope(session: Session) {
  return {
    plan: new PlanFacade(session),
    turnState: createTurnState({ activeRole: "agent" }),
    llmBundle: createUniformRoleLlmBundle({
      providerId: "mock",
      client: { baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "m" },
      stream: (async function* () {}) as unknown as StreamChatFn,
    }),
  };
}

/** Host surface actually touched by PrepareRole.Exec (host path). */
function makePrepareRoleHost(session: Session): FsmHostCapabilities {
  return {
    session,
    isSubagentTurn: false,
    createId: (() => {
      let n = 0;
      return () => `id-${++n}`;
    })(),
    gate: { fullPermissionsEnabled: true },
  } as FsmHostCapabilities;
}

describe("resolvePromptOverride helper", () => {
  it("returns null when unconfigured", async () => {
    assert.equal(await resolvePromptOverride({}), null);
  });

  it("inline wins over file", async () => {
    const file = join(testDir, "wins.md");
    await writeFile(file, "FILE BODY", "utf-8");
    const out = await resolvePromptOverride(
      { rolePromptInline: "INLINE BODY", rolePromptFile: file },
      testDir,
    );
    assert.equal(out, "INLINE BODY");
  });

  it("resolves relative file against workspacePath", async () => {
    await writeFile(join(testDir, "rel.md"), "REL BODY", "utf-8");
    const out = await resolvePromptOverride(
      { rolePromptFile: "rel.md" },
      testDir,
    );
    assert.equal(out, "REL BODY");
  });

  it("absolute path works without workspacePath", async () => {
    const file = join(testDir, "abs.md");
    await writeFile(file, "ABS BODY", "utf-8");
    const out = await resolvePromptOverride({ rolePromptFile: file });
    assert.equal(out, "ABS BODY");
  });

  it("missing absolute file throws FSMConfigError with path in message", async () => {
    const missing = join(testDir, "missing.md");
    await assert.rejects(
      resolvePromptOverride({ rolePromptFile: missing }),
      (error: unknown) => {
        assert.ok(error instanceof FSMConfigError);
        assert.equal(error.code, "ROLE_PROMPT_FILE_UNREADABLE");
        assert.ok(error.message.includes(missing));
        return true;
      },
    );
  });

  it("relative file without workspace root defers to null", async () => {
    assert.equal(
      await resolvePromptOverride({ rolePromptFile: "rel.md" }),
      null,
    );
  });

  it("empty file content falls back to null", async () => {
    const file = join(testDir, "empty.md");
    await writeFile(file, "   \n", "utf-8");
    assert.equal(await resolvePromptOverride({ rolePromptFile: file }), null);
  });

  it("supports custom key mapping (overlayInline / overlayFile)", async () => {
    const file = join(testDir, "overlay.md");
    await writeFile(file, "OVERLAY FILE", "utf-8");
    assert.equal(
      await resolvePromptOverride(
        { overlayInline: "OVERLAY INLINE", overlayFile: file },
        testDir,
        { inline: "overlayInline", file: "overlayFile" },
      ),
      "OVERLAY INLINE",
    );
    assert.equal(
      await resolvePromptOverride({ overlayFile: file }, testDir, {
        inline: "overlayInline",
        file: "overlayFile",
      }),
      "OVERLAY FILE",
    );
  });
});

describe("NodeActionPrepareRole prompt override", () => {
  const CUSTOM_PLANNER = "Custom planner persona.\nRoute: decide plan vs direct.";

  it("planner + inline replaces roleSystemPrompt (pure replacement)", async () => {
    const session = makeSession(testDir);
    const action = new NodeActionPrepareRole({
      ...rolePresetParams("planner"),
      rolePromptInline: CUSTOM_PLANNER,
    });
    const result = await action.Exec({
      turnContext: { turnScope: makeTurnScope(session) },
      nodeContext: {},
      host: makePrepareRoleHost(session),
    });

    assert.equal(result.status, "continue");
    const spec = result.nodeContextPatch?.iterationSpec as {
      roleSystemPrompt: string;
    };
    assert.ok(spec, "iterationSpec expected on host path");
    assert.ok(spec.roleSystemPrompt.startsWith("[PLANNER]"));
    assert.ok(spec.roleSystemPrompt.includes(CUSTOM_PLANNER));
    assert.ok(
      spec.roleSystemPrompt.includes(displayPath(testDir)),
      "workspace root line expected (no {{workspacePath}} placeholder)",
    );
    // Pure replacement: built-in planner template text must not leak in.
    const defaultFirstLine =
      getDefaultPlannerSystemPrompt().trim().split("\n")[0] ?? "";
    if (defaultFirstLine) {
      assert.ok(!spec.roleSystemPrompt.includes(defaultFirstLine));
    }
    // Bucket0 channel untouched for plan roles.
    assert.equal(result.nodeContextPatch?.rolePromptTemplate, undefined);
  });

  it("planner + file replaces roleSystemPrompt via workspace-root-relative path", async () => {
    const file = join(testDir, "planner-custom.md");
    await writeFile(file, CUSTOM_PLANNER, "utf-8");
    const session = makeSession(testDir);
    const action = new NodeActionPrepareRole({
      ...rolePresetParams("planner"),
      rolePromptFile: "planner-custom.md",
    });
    const result = await action.Exec({
      turnContext: { turnScope: makeTurnScope(session) },
      nodeContext: {},
      host: makePrepareRoleHost(session),
    });

    assert.equal(result.status, "continue");
    const spec = result.nodeContextPatch?.iterationSpec as {
      roleSystemPrompt: string;
    };
    assert.ok(spec.roleSystemPrompt.includes(CUSTOM_PLANNER));
  });

  it("agent + inline writes raw template to rolePromptTemplate (Bucket0 channel)", async () => {
    const session = makeSession(testDir);
    const action = new NodeActionPrepareRole({
      ...rolePresetParams("agent"),
      rolePromptInline: "Custom agent body.",
    });
    const result = await action.Exec({
      turnContext: { turnScope: makeTurnScope(session) },
      nodeContext: {},
      host: makePrepareRoleHost(session),
    });

    assert.equal(result.status, "continue");
    assert.equal(
      result.nodeContextPatch?.rolePromptTemplate,
      "Custom agent body.",
    );
    assert.equal(result.nodeContextPatch?.roleKind, "agent");
  });

  it("host path propagates FSMConfigError for unreadable file", async () => {
    const session = makeSession(testDir);
    const action = new NodeActionPrepareRole({
      ...rolePresetParams("planner"),
      rolePromptFile: join(testDir, "nope.md"),
    });
    await assert.rejects(
      action.Exec({
        turnContext: { turnScope: makeTurnScope(session) },
        nodeContext: {},
        host: makePrepareRoleHost(session),
      }),
      (error: unknown) => error instanceof FSMConfigError,
    );
  });

  it("stub path halts on unreadable absolute file", async () => {
    const action = new NodeActionPrepareRole({
      ...rolePresetParams("agent", { promptPreset: "none" }),
      rolePromptFile: join(testDir, "nope.md"),
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: {},
    });
    assert.equal(result.status, "halt");
    assert.ok(result.errorMessage?.includes("nope.md"));
  });

  it("stub path defers relative file (no workspace root) and stays continue", async () => {
    const action = new NodeActionPrepareRole({
      ...rolePresetParams("agent", { promptPreset: "none" }),
      rolePromptFile: "somewhere/custom.md",
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: {},
    });
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch?.rolePromptTemplate, undefined);
    assert.equal(result.nodeContextPatch?.iterationSpecReady, true);
  });
});

describe("NodeActionBuildModelWindow Bucket0 override priority", () => {
  function makeWindowHost(
    session: Session,
    captured: PrepareModelWindowInput[],
    isSubagentTurn = false,
  ): FsmHostCapabilities {
    return {
      session,
      isSubagentTurn,
      prepareModelWindow: async (input: PrepareModelWindowInput) => {
        captured.push(input);
        return {
          ok: true,
          messages: [{ role: "user", content: "hi" }],
          estimatedTokens: 1,
          compacted: false,
        };
      },
      finish: async () => ({ status: "error" }) as never,
    } as unknown as FsmHostCapabilities;
  }

  function agentSpec(roleKind: "agent" | "subagent" | "planner") {
    return {
      roleKind,
      promptPlacement: (roleKind === "planner" ? "system" : "persona") as "system" | "persona",
      personaLabel: "AGENT",
      roleSystemPrompt: `[${roleKind.toUpperCase()}]\nbody`,
      includeSkills: false,
    };
  }

  it("rolePromptTemplate (agent) becomes agentTemplateOverride", async () => {
    const captured: PrepareModelWindowInput[] = [];
    const session = makeSession(testDir);
    const action = new NodeActionBuildModelWindow({});
    const result = await action.Exec({
      turnContext: {},
      nodeContext: {
        iterationSpec: agentSpec("agent"),
        rolePromptTemplate: "CUSTOM AGENT TEMPLATE",
        tools: [],
      },
      host: makeWindowHost(session, captured),
    });
    assert.equal(result.status, "continue");
    assert.equal(captured.length, 1);
    assert.equal(captured[0]?.agentTemplateOverride, "CUSTOM AGENT TEMPLATE");
  });

  it("turnInput.agentSystemPrompt wins over rolePromptTemplate", async () => {
    const captured: PrepareModelWindowInput[] = [];
    const session = makeSession(testDir);
    const action = new NodeActionBuildModelWindow({});
    await action.Exec(
      {
        turnContext: {},
        nodeContext: {
          iterationSpec: agentSpec("agent"),
          rolePromptTemplate: "CUSTOM AGENT TEMPLATE",
          tools: [],
        },
        host: makeWindowHost(session, captured),
        turnInput: {
          session,
          userText: "hi",
          agentSystemPrompt: "TURN INPUT TEMPLATE",
        } as RunAgentTurnInput,
      },
    );
    assert.equal(captured[0]?.agentTemplateOverride, "TURN INPUT TEMPLATE");
  });

  it("planner rolePromptTemplate is NOT routed to Bucket0", async () => {
    const captured: PrepareModelWindowInput[] = [];
    const session = makeSession(testDir);
    const action = new NodeActionBuildModelWindow({});
    await action.Exec({
      turnContext: {},
      nodeContext: {
        iterationSpec: agentSpec("planner"),
        rolePromptTemplate: "SHOULD BE IGNORED",
        tools: [],
      },
      host: makeWindowHost(session, captured),
    });
    assert.equal(
      "agentTemplateOverride" in (captured[0] ?? {}),
      false,
      "plan roles keep AGENT.md as the persona slot",
    );
    assert.equal(
      captured[0]?.roleSystemPrompt,
      "[PLANNER]\nbody",
      "plan-role markdown is an extra Bucket0 system message",
    );
    assert.doesNotMatch(
      captured[0]?.trailingOverlay ?? "",
      /\[PLANNER\]/,
      "plan-role body is not on the trailing overlay",
    );
  });

  it("an explicitly prepared persona supplies the subagent template", async () => {
    const captured: PrepareModelWindowInput[] = [];
    const session = makeSession(testDir);
    const action = new NodeActionBuildModelWindow({});
    await action.Exec({
      turnContext: {},
      nodeContext: {
        iterationSpec: agentSpec("subagent"),
        rolePromptTemplate: getDefaultSubagentSystemPrompt(),
        tools: [],
      },
      host: makeWindowHost(session, captured, true),
    });
    assert.equal(
      captured[0]?.agentTemplateOverride,
      getDefaultSubagentSystemPrompt(),
    );
  });
});

describe("NodeActionPromptInject skill reflect overlay", () => {
  const baseSpec = {
    roleKind: "agent" as const,
    personaLabel: "AGENT" as const,
    roleSystemPrompt: "",
    includeSkills: false,
  };

  it("note replaces the trailing overlay block", () => {
    const action = new NodeActionPromptInject({
      source: "note",
      note: "CUSTOM REFLECT RULES",
    });
    const result = action.Exec({
      turnContext: {},
      nodeContext: { iterationSpec: baseSpec },
    });
    assert.equal(result.status, "continue");
    const spec = result.nodeContextPatch?.iterationSpec as {
      phaseOverlay: string;
    };
    assert.equal(spec.phaseOverlay, "CUSTOM REFLECT RULES");
  });

  it("routeGuide appends fsm_route hints", () => {
    const action = new NodeActionPromptInject({
      source: "routeGuide",
      placement: "system",
      routeGuide: [{ when: "done reviewing", routeTo: "done" }],
    });
    const result = action.Exec({
      turnContext: {},
      nodeContext: { iterationSpec: baseSpec },
    });
    const spec = result.nodeContextPatch?.iterationSpec as {
      systemInject: string;
    };
    assert.match(spec.systemInject, /fsm_route/);
    assert.match(spec.systemInject, /done/);
  });
});
