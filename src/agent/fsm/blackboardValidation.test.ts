import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FSMConfigError } from "./FSMConfigError.js";
import { createFSMGraphConfig, type FSMGraphConfig } from "./types.js";
import { validateFSMGraphConfig } from "./validateFSMGraphConfig.js";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";

const registry = createDefaultActionRegistry();

function expectConfigError(
  config: FSMGraphConfig,
  pattern: RegExp,
): void {
  assert.throws(
    () => validateFSMGraphConfig(config, registry),
    (err: unknown) =>
      err instanceof FSMConfigError && pattern.test(err.message),
  );
}

describe("blackboard action graph validation", () => {
  it("a graph using all three actions plus a typed EdgeWhen validates", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          pins: [{ name: "next" }],
          actions: [
            {
              type: "NodeActionWriteBlackboard",
              params: { key: "count", value: 1, mode: "increment" },
            },
            {
              type: "NodeActionWriteBlackboard",
              params: { key: "label", value: "hi" },
            },
            {
              type: "NodeActionReadBlackboard",
              params: { key: "count", asKey: "n" },
            },
            {
              type: "NodeActionCompare",
              params: {
                key: "n",
                type: "int",
                operator: ">=",
                value: "3",
                asKey: "flag.n",
              },
            },
            {
              type: "NodeActionRouteTo",
              params: {
                when: [{ key: "flag.n", to: "next" }],
              },
            },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [
        {
          from: "start",
          to: "end",
          type: "EdgeWhen",
          params: { turnKey: "n", type: "int", operator: ">=", value: 3 },
        },
      ],
    });
    assert.doesNotThrow(() => validateFSMGraphConfig(config, registry));
  });

  it("Write: reserved and malformed keys are rejected", () => {
    const reserved = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionWriteBlackboard",
              params: { key: "routeTarget", value: 1 },
            },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(reserved, /reserved/);

    const malformed = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionWriteBlackboard",
              params: { key: "9bad", value: 1 },
            },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(malformed, /must match/);
  });

  it("Write: increment / multiply demand a numeric value operand", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionWriteBlackboard",
              params: { key: "count", value: "abc", mode: "increment" },
            },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(config, /numeric value operand/);
  });

  it("Write: bare increment validates (+1); set / multiply still demand value", () => {
    const bare = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionWriteBlackboard",
              params: { key: "replanCount", mode: "increment" },
            },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    assert.doesNotThrow(() => validateFSMGraphConfig(bare, registry));

    const setBare = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            { type: "NodeActionWriteBlackboard", params: { key: "k", mode: "set" } },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(setBare, /mode "set" requires a value/);

    const multiplyBare = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            { type: "NodeActionWriteBlackboard", params: { key: "k", mode: "multiply" } },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(multiplyBare, /numeric value operand/);
  });

  it("Read: reserved asKey is rejected", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionReadBlackboard",
              params: { key: "k", asKey: "toolCalls" },
            },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(config, /reserved/);
  });

  it("Compare: expected value must coerce under the declared type", () => {
    const base = {
      key: "n",
      type: "int",
      operator: ">=",
      asKey: "flag.n",
    };
    const bad = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          pins: [{ name: "next" }],
          actions: [
            {
              type: "NodeActionCompare",
              params: { ...base, value: "xyz" },
            },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(bad, /not a finite int/);

    const nonIntFloat = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          pins: [{ name: "next" }],
          actions: [
            {
              type: "NodeActionCompare",
              params: { ...base, value: 1.5 },
            },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(nonIntFloat, /not an integer/);
  });

  it("RouteTo when-table: to must reference a known node pin", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          pins: [{ name: "next" }],
          actions: [
            {
              type: "NodeActionRouteTo",
              params: {
                when: [{ key: "flag.n", to: "nope" }],
              },
            },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(config, /unknown pin/);
  });

  it("EmitRouteEventWhen: valid config passes, bad value is rejected", () => {
    const base = {
      key: "n",
      type: "int",
      operator: ">=",
      event: "escalate",
    };
    const valid = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            { type: "NodeActionEmitRouteEventWhen", params: { ...base, value: "3" } },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    assert.doesNotThrow(() => validateFSMGraphConfig(valid, registry));

    const bad = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            { type: "NodeActionEmitRouteEventWhen", params: { ...base, value: "xyz" } },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(bad, /not a finite int/);

    const reserved = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionEmitRouteEventWhen",
              params: { ...base, key: "routeEvent", value: 1 },
            },
          ],
        },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    expectConfigError(reserved, /reserved/);
  });

  it("EdgeWhen: equals and typed comparison are mutually exclusive", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        { id: "start", actions: [] },
        { id: "end", actions: [] },
      ],
      edges: [
        {
          from: "start",
          to: "end",
          type: "EdgeWhen",
          params: {
            turnKey: "n",
            equals: 3,
            type: "int",
            operator: ">=",
            value: 3,
          },
        },
      ],
    });
    expectConfigError(config, /mutually exclusive/);
  });

  it("EdgeWhen: typed expected value is validated as int", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        { id: "start", actions: [] },
        { id: "end", actions: [] },
      ],
      edges: [
        {
          from: "start",
          to: "end",
          type: "EdgeWhen",
          params: { turnKey: "n", type: "int", operator: ">", value: "zzz" },
        },
      ],
    });
    expectConfigError(config, /not a finite int/);
  });
});
