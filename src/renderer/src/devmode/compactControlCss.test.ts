import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseHTML } from "linkedom";
import { ChevronUp, Zap } from "../ui/originalIcons.js";
import {
  compactControlIcon,
  DEVMODE_COMPACT_ICON_SIZE,
} from "./compactControl.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document });

const css = readFileSync(new URL("./devmode.css", import.meta.url), "utf8");

function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`));
  assert.ok(match, `missing rule: ${selector}`);
  return match[2];
}

function token(block: string, name: string): string {
  const match = block.match(new RegExp(`${name}:\\s*([^;]+);`));
  assert.ok(match, `missing token: ${name}`);
  return match[1].replace(/\s+/g, " ").trim();
}

test("the lightning button and panel expand button share one control size", () => {
  assert.equal(token(rule(":root"), "--devmode-compact-control-size"), "22px");
  const boost = rule(".devmode-index-boost");
  assert.equal(token(boost, "width"), "var(--devmode-compact-control-size)");
  assert.equal(token(boost, "height"), "var(--devmode-compact-control-size)");
  const ghost = rule(".devmode-panel-ghost");
  assert.equal(token(ghost, "height"), "var(--devmode-compact-control-size)");
  const iconOnly = rule(".devmode-panel-ghost.is-icon");
  assert.equal(token(iconOnly, "width"), "var(--devmode-compact-control-size)");
});

test("both compact controls render the same icon geometry", () => {
  assert.equal(DEVMODE_COMPACT_ICON_SIZE, 12);
  const zap = compactControlIcon(Zap);
  const chevron = compactControlIcon(ChevronUp);
  for (const icon of [zap, chevron]) {
    assert.equal(icon.getAttribute("width"), "12");
    assert.equal(icon.getAttribute("height"), "12");
  }
  assert.equal(
    zap.getAttribute("stroke-width"),
    chevron.getAttribute("stroke-width"),
  );
});

test("both controls call the shared icon helper", () => {
  const index = readFileSync(new URL("./IndexingSpeedControl.ts", import.meta.url), "utf8");
  const panel = readFileSync(new URL("./UnifiedPanelController.ts", import.meta.url), "utf8");
  assert.match(index, /this\.button\.append\(compactControlIcon\(Zap\)\)/);
  assert.match(panel, /compactControlIcon\(ChevronDown\)/);
  assert.match(panel, /compactControlIcon\(this\.collapsed \? ChevronUp : ChevronDown\)/);
});
