import assert from "node:assert/strict";
import test from "node:test";
import { DebugHoverController } from "./DebugHoverController.js";

test("lazily expands nested variables and marks reference cycles", async () => {
  const calls: number[] = [];
  const controller = new DebugHoverController(
    async (expression) => ({
      result: "{...}",
      type: "Root",
      variablesReference: expression === "root" ? 1 : 0,
    }),
    async (reference) => {
      calls.push(reference);
      return reference === 1
        ? [
            {
              name: "child",
              value: "{...}",
              type: "Child",
              variablesReference: 2,
            },
          ]
        : [
            {
              name: "parent",
              value: "{...}",
              type: "Root",
              variablesReference: 1,
            },
          ];
    },
  );

  const root = await controller.evaluate("root");
  assert.ok(root?.expandable);
  const [child] = await controller.expand(root);
  assert.ok(child?.expandable);
  const [cycle] = await controller.expand(child);
  assert.equal(cycle?.expandable, false);
  assert.equal(cycle?.terminalReason, "cycle");
  assert.deepEqual(calls, [1, 2]);
});

test("deduplicates variables requests during one hover session", async () => {
  let calls = 0;
  const controller = new DebugHoverController(
    async () => ({
      result: "{...}",
      variablesReference: 8,
    }),
    async () => {
      calls += 1;
      return [];
    },
  );
  const root = await controller.evaluate("value");
  assert.ok(root);
  await Promise.all([controller.expand(root), controller.expand(root)]);
  assert.equal(calls, 1);
});
