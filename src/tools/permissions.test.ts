import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
  checkToolPermission,
  permissionDeniedMessage,
  permissionDeniedReturnCode,
} from "./permissions.js";
import {
  resetShellSafetyConfigForTests,
  setShellSafetyConfig,
} from "./policy/shellSafetyConfig.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import type {
  PermissionGateState,
  ToolDefinition,
  ToolRiskAssessor,
} from "./types.js";

function makeGate(full: boolean): PermissionGateState {
  return {
    fullPermissionsEnabled: full,
    enableFullPermissions: () => {},
    requestConfirmation: async () => false,
    requestUserAsk: async () => null,
  };
}

function approvingGate(full: boolean): PermissionGateState {
  return {
    ...makeGate(full),
    requestConfirmation: async () => true,
  };
}

const ARGS = { command: "rm -rf build" } as const;

async function check(input: {
  assessRisk?: ToolRiskAssessor;
  full?: boolean;
  level?: 0 | 1 | 2;
  approve?: boolean;
}) {
  return checkToolPermission({
    toolName: "run_shell",
    defaultLevel: input.level ?? 1,
    arguments: { ...ARGS },
    gate: (input.approve ? approvingGate : makeGate)(input.full ?? false),
    ...(input.assessRisk ? { assessRisk: input.assessRisk } : {}),
  });
}

beforeEach(() => {
  resetShellSafetyConfigForTests();
});

describe("checkToolPermission — legacy matrix (no assessor)", () => {
  it("level 0 allows; level 1 gates on full permissions; level 2 asks", async () => {
    assert.deepEqual(await check({ level: 0 }), {
      allowed: true,
      level: 0,
    });
    const denied = await check({ level: 1, full: false });
    assert.equal(denied.allowed, false);
    if (!denied.allowed) {
      assert.equal(denied.reason, "full_permissions_required");
    }
    const allowed = await check({ level: 1, full: true });
    assert.equal(allowed.allowed, true);
    const askedDenied = await check({ level: 2, approve: false });
    assert.equal(askedDenied.allowed, false);
    const askedOk = await check({ level: 2, approve: true });
    assert.equal(askedOk.allowed, true);
  });

  it("assessor present but Safe Mode disabled → legacy matrix", async () => {
    setShellSafetyConfig({ enabled: false });
    const decision = await check({
      assessRisk: () => ({ action: "allow" }),
      level: 1,
      full: false,
    });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.reason, "full_permissions_required");
    }
  });
});

describe("checkToolPermission — risk assessor matrix", () => {
  it("allow fast-path works even at level 1 without Bypass", async () => {
    const decision = await check({
      assessRisk: () => ({ action: "allow" }),
      level: 1,
      full: false,
    });
    assert.deepEqual(decision, { allowed: true, level: 1 });
  });

  it("allow carries a rewrite instruction", async () => {
    const rewrite = {
      type: "trash" as const,
      targets: ["/w/build"],
      force: true,
      originalCommand: "rm -rf build",
    };
    const decision = await check({
      assessRisk: () => ({ action: "allow", rewrite }),
    });
    assert.deepEqual(decision, { allowed: true, level: 1, rewrite });
  });

  it("confirm routes to the confirmation card (deny on reject)", async () => {
    const denied = await check({
      assessRisk: () => ({
        action: "confirm",
        fatal: false,
        reason: "writes outside the workspace",
        hint: "keep writes inside the workspace",
      }),
      approve: false,
    });
    assert.equal(denied.allowed, false);
    if (!denied.allowed) {
      assert.equal(denied.reason, "user_denied");
      assert.equal(denied.detail?.reason, "writes outside the workspace");
    }
    const approved = await check({
      assessRisk: () => ({ action: "confirm", fatal: false, reason: "x" }),
      approve: true,
    });
    assert.equal(approved.allowed, true);
  });

  it("approved confirm carries its rewrite — approval runs the Trash move", async () => {
    const rewrite = {
      type: "trash" as const,
      targets: ["/Users/tester/Developer/JellyBot/.git"],
      force: true,
      originalCommand: "rm -rf .git",
    };
    const decision = await check({
      assessRisk: () => ({
        action: "confirm",
        fatal: true,
        reason: "rm targets the version-control directory",
        hint: "approving moves it to the Trash instead of deleting",
        rewrite,
      }),
      approve: true,
    });
    assert.deepEqual(decision, { allowed: true, level: 1, rewrite });
  });

  it("Ask(2) override on an allow assessment keeps the rewrite after approval", async () => {
    const rewrite = {
      type: "trash" as const,
      targets: ["/w/build"],
      force: false,
      originalCommand: "rm build",
    };
    const decision = await check({
      assessRisk: () => ({ action: "allow", rewrite }),
      level: 2,
      approve: true,
    });
    assert.deepEqual(decision, { allowed: true, level: 2, rewrite });
  });

  it("block denies outright with detail", async () => {
    const decision = await check({
      assessRisk: () => ({
        action: "block",
        reason: "fatal rule",
        hint: "ask the user",
      }),
      approve: true, // approval must not bypass a block
      full: true, // neither must Bypass
    });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) {
      assert.equal(decision.reason, "risk_blocked");
      assert.equal(decision.detail?.reason, "fatal rule");
    }
  });
});

describe("permissionDeniedMessage", () => {
  it("full_permissions_required keeps the legacy wording", () => {
    const msg = permissionDeniedMessage("run_shell", {
      allowed: false,
      level: 1,
      reason: "full_permissions_required",
    });
    assert.match(msg, /enable Bypass permissions to run run_shell/);
    assert.match(msg, /request_full_permissions/);
  });

  it("risk_blocked and user_denied include detail + hint", () => {
    assert.match(
      permissionDeniedMessage("run_shell", {
        allowed: false,
        level: 1,
        reason: "risk_blocked",
        detail: { reason: "mkfs formats a disk", hint: "use Disk Utility" },
      }),
      /blocked by Shell Safe Mode \(mkfs formats a disk — use Disk Utility\)/,
    );
    assert.match(
      permissionDeniedMessage("run_shell", {
        allowed: false,
        level: 1,
        reason: "user_denied",
        detail: { reason: "curl | sh" },
      }),
      /not approved \(curl \| sh\)/,
    );
  });
});

describe("return codes", () => {
  it("user_denied cancels; others deny", () => {
    assert.equal(
      permissionDeniedReturnCode("user_denied"),
      ToolReturnCode.Cancelled,
    );
    assert.equal(
      permissionDeniedReturnCode("risk_blocked"),
      ToolReturnCode.PermissionDenied,
    );
    assert.equal(
      permissionDeniedReturnCode("full_permissions_required"),
      ToolReturnCode.PermissionDenied,
    );
  });
});

describe("ToolDefinition.assessRisk surface", () => {
  it("is optional on the definition type", () => {
    const def: ToolDefinition = {
      name: "x",
      description: "x",
      parameters: { type: "object", properties: {} },
      defaultPermissionLevel: 0,
    };
    assert.equal(def.assessRisk, undefined);
  });
});
