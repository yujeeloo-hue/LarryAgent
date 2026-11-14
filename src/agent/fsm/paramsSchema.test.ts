import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeAndValidateParams } from "./paramsSchema.js";

describe("normalizeAndValidateParams numeric coerce", () => {
  const schema = {
    type: "object" as const,
    additionalProperties: false,
    properties: {
      minElapsedMs: {
        type: "integer" as const,
        default: 600_000,
        minimum: 0,
      },
    },
  };

  it("coerces numeric strings to integers on save", () => {
    const out = normalizeAndValidateParams(
      schema,
      { minElapsedMs: "600000" },
      "NotifyTaskDone",
    );
    assert.equal(out.minElapsedMs, 600_000);
    assert.equal(typeof out.minElapsedMs, "number");
  });

  it("applies integer defaults when omitted", () => {
    const out = normalizeAndValidateParams(schema, {}, "NotifyTaskDone");
    assert.equal(out.minElapsedMs, 600_000);
  });
});
