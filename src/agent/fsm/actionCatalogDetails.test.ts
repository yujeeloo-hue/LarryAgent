import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";

describe("NodeAction catalog details", () => {
  const catalog = createDefaultActionRegistry().listActionCatalog();

  it("every action carries title, description and non-empty details", () => {
    assert.ok(catalog.length >= 32, `expected >= 32 actions, got ${catalog.length}`);
    const missing: string[] = [];
    for (const entry of catalog) {
      const schema = entry.paramsSchema as Record<string, unknown>;
      const details = schema.details;
      if (
        !entry.title?.trim() ||
        !entry.description?.trim() ||
        typeof details !== "string" ||
        !details.trim()
      ) {
        missing.push(entry.type);
      }
    }
    assert.deepEqual(missing, [], `actions missing catalog help: ${missing.join(", ")}`);
  });

  it("details are substantive plain text paragraphs", () => {
    for (const entry of catalog) {
      const details = (entry.paramsSchema as Record<string, unknown>).details;
      assert.equal(typeof details, "string");
      const text = details as string;
      assert.ok(text.length >= 80, `${entry.type}: details too short`);
      assert.ok(text.length <= 2000, `${entry.type}: details too long`);
      assert.equal(text, text.trim());
      assert.doesNotMatch(text, /<\/|<script/i);
    }
  });
});
