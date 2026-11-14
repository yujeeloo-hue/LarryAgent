import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultActionRegistry } from "../actions/createDefaultActionRegistry.js";
import {
  llmDescriptionOf,
  toLlmParamsSchema,
} from "./llmCatalog.js";
import {
  describeAction,
  describeEdge,
  listActionCatalogSlim,
  listEdgeCatalogSlim,
} from "./manager.js";

/**
 * Audience split for catalog copy: the Graph Editor reads
 * title/description/details + x-ui chrome; the fsm_graph tool (LLM) reads
 * `x-llmDescription ?? description` and a paramsSchema projection with the
 * editor chrome stripped. These tests pin the LLM side of that contract.
 */
/** Recursively assert no schema node keeps editor-only fields. */
function assertNoEditorKeys(
  node: unknown,
  path: string,
  insidePropertyMap = false,
): void {
  if (Array.isArray(node)) {
    node.forEach((item, i) => assertNoEditorKeys(item, `${path}[${i}]`));
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  if (!insidePropertyMap) {
    for (const banned of ["title", "x-ui", "x-enumLabels", "x-showWhen"]) {
      assert.ok(
        !(banned in obj),
        `${path}: LLM projection still contains editor key "${banned}"`,
      );
    }
  }
  for (const [key, value] of Object.entries(obj)) {
    assertNoEditorKeys(
      value,
      `${path}.${key}`,
      key === "properties" || key === "x-enumLabels",
    );
  }
}

describe("fsm catalog human/LLM description split", () => {
  const registry = createDefaultActionRegistry();

  it("every registered action and edge carries a non-empty x-llmDescription", () => {
    const missing: string[] = [];
    for (const type of registry.listActionTypes()) {
      const schema = registry.getActionParamsSchema(type);
      if (!schema["x-llmDescription"]?.trim()) missing.push(type);
    }
    for (const type of registry.listEdgeTypes()) {
      const schema = registry.getEdgeParamsSchema(type);
      if (!schema["x-llmDescription"]?.trim()) missing.push(type);
    }
    assert.deepEqual(
      missing,
      [],
      `types missing x-llmDescription: ${missing.join(", ")}`,
    );
  });

  it("slim catalogs use the LLM text and carry no editor title", () => {
    const actions = listActionCatalogSlim();
    assert.ok(actions.length >= 32);
    assert.equal(JSON.stringify(actions).includes('"title"'), false);
    for (const entry of actions) {
      const schema = registry.getActionParamsSchema(entry.type);
      assert.equal(entry.description, schema["x-llmDescription"]);
      assert.ok(entry.description?.trim(), `${entry.type}: empty description`);
    }
    const edges = listEdgeCatalogSlim();
    assert.equal(JSON.stringify(edges).includes('"title"'), false);
    for (const entry of edges) {
      const schema = registry.getEdgeParamsSchema(entry.type);
      assert.equal(entry.description, schema["x-llmDescription"]);
    }
  });

  it("describe projections strip editor chrome but keep semantics", () => {
    for (const type of registry.listActionTypes()) {
      const entry = describeAction(type);
      assert.ok(entry, `${type}: describeAction returned null`);
      assertNoEditorKeys(entry, type);
      const schema = registry.getActionParamsSchema(type);
      if (schema.details?.trim()) {
        assert.equal(entry!.paramsSchema.details, schema.details, `${type}: details dropped`);
      }
      assert.equal(
        entry!.paramsSchema["x-emitsRouteEvents"],
        schema["x-emitsRouteEvents"],
        `${type}: x-emitsRouteEvents must survive projection`,
      );
    }
    const when = describeEdge("EdgeWhen");
    assert.ok(when?.description?.includes("turnKey"));
    assert.ok(when?.paramsSchema.properties, "EdgeWhen properties dropped");
    const always = describeEdge("EdgeAlways");
    assert.ok(always?.description?.includes("Always-true"));
  });

  it("projection keeps enum/default/required and nested item properties", () => {
    const compare = describeAction("NodeActionCompare");
    assert.ok(compare);
    const props = compare!.paramsSchema.properties as Record<
      string,
      Record<string, unknown>
    >;
    assert.deepEqual(
      (props.source?.enum as string[])?.slice(0, 2),
      ["blackboard", "planOpenSteps"],
    );
    assert.equal(
      props.asKey?.description,
      "Turn register name receiving true/false. RouteTo when[].expr references this flag.",
    );
    const routeTo = describeAction("NodeActionRouteTo");
    const when = (routeTo!.paramsSchema.properties as Record<string, Record<string, unknown>>).when;
    const items = when?.items as Record<string, unknown>;
    const itemProps = items?.properties as Record<string, Record<string, unknown>>;
    assert.equal(itemProps?.expr?.type, "string");
    assert.ok((itemProps?.expr?.description as string)?.includes("Compare asKey"));
    // Editor-only key must not leak through nested items either.
    assert.equal(JSON.stringify(routeTo).includes('"x-ui"'), false);
  });

  it("llmDescriptionOf prefers the override and trims", () => {
    assert.equal(
      llmDescriptionOf({
        description: "human",
        "x-llmDescription": " llm text ",
      }),
      "llm text",
    );
    assert.equal(llmDescriptionOf({ description: " human " }), "human");
    assert.equal(llmDescriptionOf({}), undefined);
    assert.equal(
      llmDescriptionOf({ "x-llmDescription": "   " , description: "fallback" }),
      "fallback",
    );
  });

  it("toLlmParamsSchema projects object/array properties recursively", () => {
    const projected = toLlmParamsSchema({
      type: "object",
      title: "Editor label",
      description: "human summary",
      "x-llmDescription": "llm summary",
      details: "shared reference",
      additionalProperties: false,
      required: ["key"],
      "x-ui": "route-to",
      properties: {
        key: {
          type: "string",
          minLength: 1,
          title: "Key",
          description: "human key help",
          "x-ui": "text",
        },
        rows: {
          type: "array",
          title: "Rows",
          "x-ui": "hidden",
          items: {
            type: "object",
            required: ["to"],
            properties: {
              to: {
                type: "string",
                minLength: 1,
                title: "To",
                "x-ui": "pin-select",
                "x-llmDescription": "llm to help",
                description: "human to help",
              },
            },
          },
        },
      },
    });
    assert.deepEqual(projected, {
      type: "object",
      description: "llm summary",
      details: "shared reference",
      additionalProperties: false,
      required: ["key"],
      properties: {
        key: { type: "string", minLength: 1, description: "human key help" },
        rows: {
          type: "array",
          items: {
            type: "object",
            required: ["to"],
            properties: {
              to: { type: "string", minLength: 1, description: "llm to help" },
            },
          },
        },
      },
    });
  });
});
