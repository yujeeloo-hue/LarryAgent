import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { icon, icons } from "../src/icons.js";
import { toolMeta } from "../src/toolDisplay.js";
import { toolIconCatalog } from "../../../src/shared/icons/toolIconCatalog.js";

test("Relay retains its original outline artwork and stroke at every UI size", () => {
  for (const name of Object.keys(icons)) {
    for (const size of [12, 13, 16, 20, 28]) {
      const { document } = parseHTML(icon(name, size));
      const svg = document.querySelector("svg")!;
      assert.equal(svg.getAttribute("fill"), "none", name);
      assert.equal(svg.getAttribute("stroke"), "currentColor", name);
      assert.equal(svg.getAttribute("stroke-width"), "2", name);
      assert.equal(svg.getAttribute("width"), String(size), name);
      assert.equal(svg.getAttribute("height"), String(size), name);
      assert.equal(svg.querySelectorAll("defs, mask, image, [data-functional-icon]").length, 0, name);
    }
  }
});

test("all current tool labels resolve to a real Relay outline icon", () => {
  for (const [name, meta] of Object.entries(toolIconCatalog)) {
    const relay = toolMeta(name);
    assert.equal(relay.displayName, meta.displayName, name);
    assert.ok(Object.hasOwn(icons, relay.icon), `${name}: ${relay.icon}`);
  }
  assert.equal(toolMeta("ask_user").icon, "messagesSquare");
  assert.equal(icon("unknown"), icon("wrench"));
});
