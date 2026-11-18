import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FSMConfigError } from "./FSMConfigError.js";
import {
  normalizeAndValidateParams,
  type FsmParamsSchema,
} from "./paramsSchema.js";
import { NodeActionRouteToSchema } from "./actions/NodeActionRouteTo.js";
import {
  describeNodeActionRoleRoundBuilderChildren,
  NodeActionRoleRoundBuilderSchema,
} from "./actions/NodeActionRoleRoundBuilder.js";

function invalidParam(path: string) {
  return (error: unknown) => error instanceof FSMConfigError &&
    error.code === "INVALID_ACTION_PARAMS" && error.message.includes(path);
}

describe("nested FSM parameter validation", () => {
  it("rejects invalid fields in the real route table schemas", () => {
    assert.throws(() => normalizeAndValidateParams(
      NodeActionRouteToSchema,
      { routes: [{ event: "stay", to: 42 }] },
      "RouteTo",
    ), invalidParam("routes[0].to"));
    assert.throws(() => normalizeAndValidateParams(
      NodeActionRouteToSchema,
      { when: [{ expr: "ready", to: "end", allOf: [false] }] },
      "RouteTo",
    ), invalidParam("when[0].allOf[0]"));
  });

  it("validates nested object fields without filling partial override defaults", () => {
    assert.throws(() => normalizeAndValidateParams(
      NodeActionRoleRoundBuilderSchema,
      { prepareRole: { modelBinding: "missing" } },
      "RoleRoundBuilder",
    ), invalidParam("prepareRole.modelBinding"));

    const params = normalizeAndValidateParams(
      NodeActionRoleRoundBuilderSchema,
      { prepareRole: {}, routeTo: {} },
      "RoleRoundBuilder",
    );
    assert.deepEqual(params.prepareRole, {});
    assert.equal("prepareTools" in params, false);
    const children = describeNodeActionRoleRoundBuilderChildren(params, "RoleRoundBuilder");
    const prepareRole = children.find((child) => child.type === "NodeActionPrepareRole")!;
    assert.equal(prepareRole.params!.modelBinding, "agent");
    assert.equal(prepareRole.params!.promptPreset, "agent");
    assert.equal(prepareRole.params!.promptPlacement, "persona");
  });

  it("normalizes nested numbers without mutating the caller or schema defaults", () => {
    const schema: FsmParamsSchema = {
      type: "object",
      properties: {
        settings: {
          type: "object",
          default: { limits: [{ count: "3" }] },
          properties: {
            limits: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  count: { type: "integer", minimum: 1 },
                  optional: { type: "boolean", default: true },
                },
              },
            },
          },
        },
      },
    };
    const input = { settings: { limits: [{ count: "2" }] } };
    const before = structuredClone(input);
    const schemaBefore = structuredClone(schema);
    assert.deepEqual(normalizeAndValidateParams(schema, input, "Action"), {
      settings: { limits: [{ count: 2 }] },
    });
    assert.deepEqual(normalizeAndValidateParams(schema, {}, "Action"), {
      settings: { limits: [{ count: 3 }] },
    });
    assert.deepEqual(input, before);
    assert.deepEqual(schema, schemaBefore);
    assert.throws(() => normalizeAndValidateParams(schema, {
      settings: { limits: [{ count: "0" }] },
    }, "Action"), invalidParam("settings.limits[0].count"));
  });

  it("preserves open objects and optional route fields", () => {
    const params = {
      when: [{ key: "ready", pin: "end", extension: { version: 1 } }],
    };
    const out = normalizeAndValidateParams(NodeActionRouteToSchema, params, "RouteTo");
    assert.deepEqual(out.when, params.when);
    const opaqueSchema: FsmParamsSchema = {
      type: "object",
      properties: {
        value: { type: "object" },
        steps: { type: "array", items: { type: "object" } },
      },
    };
    const opaque = { value: { custom: [1, true] }, steps: [{ custom: { key: null } }] };
    assert.deepEqual(normalizeAndValidateParams(opaqueSchema, opaque, "Action"), opaque);
  });

  it("enforces declared string item constraints", () => {
    assert.throws(() => normalizeAndValidateParams(
      NodeActionRouteToSchema,
      { allOf: [""] },
      "RouteTo",
    ), invalidParam("allOf[0]"));
  });

  it("checks explicit nested required and closed-object rules", () => {
    const schema: FsmParamsSchema = {
      type: "object",
      properties: {
        settings: {
          type: "object",
          additionalProperties: false,
          required: ["enabled"],
          properties: { enabled: { type: "boolean" } },
        },
        rows: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
    };
    for (const [params, path] of [
      [{ settings: {} }, "settings.enabled"],
      [{ settings: { enabled: true, unknown: 1 } }, "settings.unknown"],
      [{ rows: [{}] }, "rows[0].name"],
      [{ rows: [{ name: "ok", unknown: 1 }] }, "rows[0].unknown"],
    ] as const) {
      assert.throws(() => normalizeAndValidateParams(schema, params, "Action"), invalidParam(path));
    }
    assert.deepEqual(normalizeAndValidateParams(schema, {}, "Action"), {});
    assert.deepEqual(normalizeAndValidateParams(schema, {
      settings: { enabled: false }, rows: [{ name: "ok" }],
    }, "Action"), { settings: { enabled: false }, rows: [{ name: "ok" }] });
  });

  it("keeps validating legacy string maps inside nested objects and arrays", () => {
    const schema: FsmParamsSchema = {
      type: "object",
      properties: {
        bindings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: { type: "string", minLength: 1 },
          },
        },
      },
    };
    const params = { bindings: [{ ready: "end" }] };
    assert.deepEqual(normalizeAndValidateParams(schema, params, "Action"), params);
    for (const value of [42, ""]) {
      assert.throws(() => normalizeAndValidateParams(schema, {
        bindings: [{ ready: value }],
      }, "Action"), invalidParam("bindings[0].ready"));
    }
  });
});
