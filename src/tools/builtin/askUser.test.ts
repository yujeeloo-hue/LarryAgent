import assert from "node:assert/strict";
import { test } from "node:test";
import { askUserDefinition, askUserHandler } from "./askUser.js";
import { registerBuiltins } from "../index.js";
import { toolsToOpenAi } from "../../agent/toolsToOpenAi.js";
import { validateToolArguments } from "../validateToolArguments.js";
import type { ToolExecuteContext, UserAskRequestInput, UserAskAnswer } from "../types.js";

function context(answer: UserAskAnswer, received: UserAskRequestInput[]): ToolExecuteContext {
  return { workspacePath: "/tmp", fullPermissionsEnabled: false,
    requestUserAsk: async input => { received.push(input); return answer; } };
}
function body(result: Awaited<ReturnType<typeof askUserHandler>>) {
  assert.equal(result.returnCode, 0);
  const part = result.content[0];
  assert.ok(part?.type === "text");
  return JSON.parse(part.text);
}

test("published model schema advertises the simplified option objects and answer contract", () => {
  registerBuiltins();
  const tool = toolsToOpenAi().find(t => t.function.name === "ask_user")!;
  assert.deepEqual(tool.function.parameters, askUserDefinition.parameters);
  const schema = tool.function.parameters as any;
  assert.deepEqual(schema.required, ["question"]);
  assert.deepEqual(Object.keys(schema.properties), ["question", "options", "multiple"]);
  assert.equal(schema.properties.options.items.type, "object");
  assert.deepEqual(schema.properties.options.items.required, ["label"]);
  assert.ok(schema.properties.options.items.properties.description);
  assert.ok(schema.properties.options.items.properties.recommended);
  assert.match(tool.function.description!, /selected_options.*custom_answer.*comment/);
  assert.match(schema.properties.multiple.description, /default false/);
  assert.match(schema.properties.options.description, /Omit or pass \[\]/);
  assert.equal(validateToolArguments({ question: "Pick?", options: [{ label: "A" }], multiple: true }, schema).ok, true);
});

test("model calls validate against the strict schema with a precise error", () => {
  assert.equal(askUserDefinition.validationParameters, undefined);
  const schema = askUserDefinition.parameters;
  const strings = validateToolArguments({ question: "Pick?", options: ["A", "B"] }, schema);
  assert.deepEqual(strings, { ok: false, error: 'Invalid arguments: "options[0]" expected object, got string.' });
  const noLabel = validateToolArguments({ question: "Pick?", options: [{ description: "cut off" }] }, schema);
  assert.deepEqual(noLabel, { ok: false, error: 'Invalid arguments: missing required property "options[0].label".' });
  assert.equal(validateToolArguments({ question: "Pick?", options: [{ label: "A" }], allow_multiple: true }, schema).ok, false);
});

test("malformed options and leaked JSON are rejected instead of shown to the user", async () => {
  const cases: [unknown, RegExp][] = [
    [{ question: "Pick?", options: [{ label: "A" }, { label: " " }] }, /options\[1\]\.label" is empty/],
    [{ question: "Pick?", options: [{ label: "A" }, { label: "A" }] }, /duplicate option label/],
    [{ question: "Pick?", options: [{ label: "A" }, null] }, /options\[1\]" must be an object/],
    [{ question: "Pick?", options: ["description: Handed-off turns", "label: ", "   "] }, /field name as text/],
    [{ question: "Go ahead?\"]", options: [{ label: "Yes" }, { label: "No" }] }, /question" ends with leftover JSON/],
    [{ question: "Which?\"}';\n" }, /question" ends with leftover JSON/],
    [{ question: "Pick?", options: [{ label: "A", description: "cut \"}]" }, { label: "B" }] }, /options\[0\]" text ends with leftover JSON/],
  ];
  for (const [args, pattern] of cases) {
    const received: UserAskRequestInput[] = [];
    const result = await askUserHandler(args as never, context({ selected: "A", custom: false }, received));
    assert.equal(result.returnCode, 5);
    const part = result.content[0];
    assert.ok(part?.type === "text");
    assert.match(part.text, pattern);
    assert.equal(received.length, 0);
  }
});

test("object options preserve descriptions and recommendations and carry selection notes", async () => {
  const received: UserAskRequestInput[] = [];
  const result = await askUserHandler({ question: " Scope? ", options: [
    { label: " Preview ", description: " Review first ", recommended: true },
    { label: "Implement" },
  ] }, context({ selected: "Preview", custom: false, comment: " Keep mobile support.\nNo deployment. " }, received));
  assert.deepEqual(received[0], { question: "Scope?", options: ["Preview", "Implement"],
    optionDetails: [{ label: "Preview", description: "Review first", recommended: true }, { label: "Implement" }],
    allowCustom: true, allowMultiple: false });
  assert.deepEqual(body(result), { selected_options: ["Preview"], custom_answer: null, comment: "Keep mobile support.\nNo deployment." });
});

test("new multiple flag takes precedence; legacy string options and flags remain supported", async () => {
  for (const flags of [{ multiple: true }, { allow_multiple: true }, { multiple: false, allow_multiple: true }]) {
    const received: UserAskRequestInput[] = [];
    await askUserHandler({ question: "Pick?", options: ["A", "B"], ...flags }, context({ selected: "A", custom: false }, received));
    assert.equal(received[0]?.allowMultiple, "multiple" in flags ? flags.multiple : true);
  }
  const received: UserAskRequestInput[] = [];
  const result = await askUserHandler({ question: "Pick?", options: ["A, with comma", "B"], multiple: true },
    context({ selected: "A, with comma, B", selections: ["A, with comma", "B"], custom: false }, received));
  assert.deepEqual(body(result), { selected_options: ["A, with comma", "B"], custom_answer: null, comment: null });
});

test("omitted options produce a multiline free response even with legacy custom disabled", async () => {
  const received: UserAskRequestInput[] = [];
  const result = await askUserHandler({ question: "What matters?", multiple: true, allow_custom: false },
    context({ selected: "Line one\nLine two", custom: true }, received));
  assert.equal(received[0]?.allowMultiple, false);
  assert.equal(received[0]?.allowCustom, true);
  assert.deepEqual(body(result), { selected_options: [], custom_answer: "Line one\nLine two", comment: null });
});
