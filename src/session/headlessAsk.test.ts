import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ToolReturnCode } from "./returnCodes.js";
import { askUserHandler } from "../tools/builtin/askUser.js";
import { promptTurnLimitContinue } from "../agent/turnHost/turnBudget.js";
import {
  HEADLESS_ASK_CANCELLED_TEXT,
  resolveAskAwait,
} from "./headlessAsk.js";
import type { ToolExecuteContext } from "../tools/types.js";
import type { Session } from "./types.js";

function askContext(headlessMode = false): ToolExecuteContext {
  return {
    workspacePath: "/tmp",
    fullPermissionsEnabled: false,
    headlessMode,
    requestUserAsk: async () => null,
  };
}

function minimalSession(): Session {
  return {
    id: "s1",
    type: "agent",
    title: "Test",
    createdAt: 1,
    updatedAt: 1,
    status: "running",
    progressText: "",
    messages: [],
    model: "m",
    providerId: "p",
    workspaceId: "w",
    workspacePath: "/tmp",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
  };
}

describe("resolveAskAwait (headless ask policy)", () => {
  it("headless turns auto-settle with a cancel-equivalent null answer", () => {
    const decision = resolveAskAwait({ headless: true });
    assert.equal(decision.kind, "auto-settle");
    assert.ok(decision.kind === "auto-settle");
    assert.equal(decision.answer, null);
    assert.equal(decision.note, HEADLESS_ASK_CANCELLED_TEXT);
  });

  it("interactive turns wait for the renderer", () => {
    assert.equal(resolveAskAwait({ headless: false }).kind, "wait");
  });

  it("cancel note mentions the background loop and the auto-cancel", () => {
    assert.match(HEADLESS_ASK_CANCELLED_TEXT, /Loop/);
    assert.match(HEADLESS_ASK_CANCELLED_TEXT, /auto-cancelled/);
  });
});

describe("ask_user result text", () => {
  const args = { question: "Proceed?", options: ["Yes", "No"] };

  it("headless: cancelled result carries the headless note", async () => {
    const result = await askUserHandler(args, askContext(true));
    assert.equal(result.returnCode, ToolReturnCode.Cancelled);
    assert.deepEqual(result.content, [
      { type: "text", text: HEADLESS_ASK_CANCELLED_TEXT },
    ]);
  });

  it("interactive: cancelled result keeps the legacy text", async () => {
    const result = await askUserHandler(args, askContext());
    assert.equal(result.returnCode, ToolReturnCode.Cancelled);
    assert.deepEqual(result.content, [
      { type: "text", text: "User did not answer (cancelled)." },
    ]);
  });
});

describe("ask_user open-ended (no options)", () => {
  it("forwards an open-ended ask: empty options, free-form forced", async () => {
    const forwarded: unknown[] = [];
    const context: ToolExecuteContext = {
      workspacePath: "/tmp",
      fullPermissionsEnabled: false,
      requestUserAsk: async (input) => {
        forwarded.push(input);
        return { selected: "Calm and low-contrast", custom: true };
      },
    };
    const result = await askUserHandler(
      {
        question: "What color scheme do you prefer?",
        allow_custom: false,
        allow_multiple: true,
      },
      context,
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.equal(forwarded.length, 1);
    const ask = forwarded[0] as {
      question: string;
      options: string[];
      allowCustom: boolean;
      allowMultiple: boolean;
    };
    assert.equal(ask.question, "What color scheme do you prefer?");
    assert.deepEqual(ask.options, []);
    assert.equal(ask.allowCustom, true);
    assert.equal(ask.allowMultiple, false);
    assert.deepEqual(result.content, [
      { type: "text", text: JSON.stringify({ selected_options: [], custom_answer: "Calm and low-contrast", comment: null }) },
    ]);
  });

  it("keeps non-array options usable and rejects blank option labels", async () => {
    const forwarded: {
      options: string[];
      allowCustom?: boolean;
    }[] = [];
    const context: ToolExecuteContext = {
      workspacePath: "/tmp",
      fullPermissionsEnabled: false,
      requestUserAsk: async (input) => {
        forwarded.push(input as { options: string[]; allowCustom?: boolean });
        return { selected: "ok", custom: true };
      },
    };
    const junk = await askUserHandler(
      { question: "Q?", options: "yes / no" },
      context,
    );
    const blank = await askUserHandler(
      { question: "Q?", options: ["  ", ""] },
      context,
    );
    // Non-array junk still degrades to an open-ended ask…
    assert.equal(junk.returnCode, ToolReturnCode.Success);
    // …while blank labels are now rejected so the model rewrites the call.
    assert.equal(blank.returnCode, ToolReturnCode.InvalidArguments);
    assert.deepEqual(forwarded.map((item) => item.options), [[]]);
    assert.equal(
      forwarded.every((item) => item.allowCustom === true),
      true,
    );
  });

  it("still rejects an empty question", async () => {
    const result = await askUserHandler({ options: ["A", "B"] }, askContext());
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
  });
});

describe("turn-limit synthetic ask (headless)", () => {
  it("auto-settles as stop and records the headless note", async () => {
    const session = minimalSession();
    let seq = 0;
    const decision = await promptTurnLimitContinue({
      session,
      gate: {
        fullPermissionsEnabled: false,
        enableFullPermissions: () => {},
        requestConfirmation: async () => false,
        requestUserAsk: async () => null,
        headless: true,
      },
      createId: () => `id-${seq++}`,
      kind: "iterations",
      question: "Continue with another budget, or stop here?",
    });
    assert.equal(decision, "stop");
    const toolMessage = session.messages.at(-1);
    assert.ok(toolMessage && toolMessage.role === "tool");
    assert.equal(
      toolMessage.parts[0]?.type === "tool_result"
        ? toolMessage.parts[0].content[0]?.type === "text"
          ? toolMessage.parts[0].content[0].text
          : null
        : null,
      HEADLESS_ASK_CANCELLED_TEXT,
    );
  });
});
