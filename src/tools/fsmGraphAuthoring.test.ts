import assert from "node:assert/strict";
import { it } from "node:test";
import { fsmGraphAuthoringDefinitions } from "./builtin/fsmGraphAuthoring.js";
import { TOOL_CATEGORIES, TOOL_CATEGORY_BY_NAME } from "./catalog.js";
import { registerBuiltins } from "./index.js";
import { getTool } from "./registry.js";
it("registers only the new authoring tools under the dedicated FSM Graph category", () => {
  registerBuiltins();
  assert.equal(TOOL_CATEGORIES.find(c => c.id === "fsm-graph")!.label, "FSM Graph");
  assert.equal(getTool("fsm_graph"), undefined);
  assert.equal(getTool("fsm_graph_edit"), undefined);
  for (const {
    definition
  } of fsmGraphAuthoringDefinitions) {
    assert.ok(getTool(definition.name));
    assert.equal(TOOL_CATEGORY_BY_NAME[definition.name as keyof typeof TOOL_CATEGORY_BY_NAME], "fsm-graph");
    assert.match(definition.description, /context|Context/);
  }
});
