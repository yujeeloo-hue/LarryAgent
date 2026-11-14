import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import * as lucide from "lucide";
import { functionalIconArtwork, functionalIconSvg } from "./functionalIcons.js";
import { toolIconCatalog } from "./toolIconCatalog.js";
import { colorIconSources } from "./colorIcons.js";
import { desktopFunctionalIconNames } from "../../renderer/src/ui/functionalIconNames.js";
import { createLucideIcon } from "../../renderer/src/ui/icons.js";
import { createLucideIcon as createOriginalIcon } from "../../renderer/src/ui/originalIcons.js";
import { originalIconSvg } from "./originalIcons.js";
import { getToolDisplayMeta } from "../../renderer/src/screens/conversation/cards/toolDisplay.js";

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sourceFiles(path.join(directory, entry.name)) : [path.join(directory, entry.name)]);
}

test("conversation and FSM graph editor retain original icons except the queue header artwork", () => {
  const files = ["conversation", "graph-editor"].flatMap(surface =>
    sourceFiles(`src/renderer/src/screens/${surface}`));
  for (const file of files
    .filter(file => file.endsWith(".ts") && !file.endsWith(".test.ts"))) {
    let source = readFileSync(file, "utf8");
    // The redesigned queue uses shared Layers2 artwork only for its header.
    // Keep the original adapter requirement for every other queue icon.
    if (path.basename(file) === "PromptQueueView.ts") {
      assert.match(source, /head\.append\(createFunctionalIcon\("Layers2", 14\)\);/);
      source = source
        .replace('import { createFunctionalIcon } from "../../ui/icons.js";', "")
        .replace('head.append(createFunctionalIcon("Layers2", 14));', "");
    }
    assert.doesNotMatch(source, /from\s+["'][^"']*\/ui\/icons\.js["']/, file);
    assert.doesNotMatch(source, /\b(?:createFunctionalIcon|functionalIconSvg|createMonoIcon)\s*\(/, file);
  }
});

test("shared artwork stays synchronized with its editable SVG sources", () => {
  const directory = path.resolve("src/shared/icons/svg");
  assert.equal(readdirSync(directory).filter(n => n.endsWith(".svg")).length, Object.keys(functionalIconArtwork).length);
  for (const [name, svg] of Object.entries(functionalIconArtwork)) {
    assert.equal(svg, readFileSync(path.join(directory, `${name}.svg`), "utf8").trim(), name);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.doesNotMatch(svg, /stroke="(?!none)[^"]+"|<image\b|<script\b/);
    const { document } = parseHTML(svg);
    const ids = [...document.querySelectorAll("[id]")].map(el => el.id);
    assert.equal(new Set(ids).size, ids.length, `${name}: mask IDs must be unique`);
    for (const ref of svg.matchAll(/url\(#([^\)]+)\)|href="#([^"]+)"/g)) {
      assert.ok(ids.includes(ref[1] ?? ref[2]!), `${name}: missing SVG reference`);
    }
  }
});

test("shared color artwork preserves the approved navigation, Settings and Tools sources", () => {
  const folders = {
    navigation: "agent-nav/active",
    settings: "setting-categories",
    tools: "tools-categories",
  };
  for (const [group, entries] of Object.entries(colorIconSources)) {
    const folder = folders[group as keyof typeof folders];
    for (const [name, uri] of Object.entries(entries)) {
      assert.equal(decodeURIComponent(uri.slice(uri.indexOf(",") + 1)),
        readFileSync(`src/renderer/src/assets/${folder}/${name}.svg`, "utf8").trim(), `${group}/${name}`);
    }
  }
});

test("repeated trash buttons do not reference masks in other hidden buttons", () => {
  const svg = functionalIconSvg("Trash2", 14);
  const { document } = parseHTML(`<html><body><div hidden>${svg}</div>${svg}${svg}</body></html>`);
  assert.equal(document.querySelectorAll("[id], [mask], defs").length, 0);
  assert.equal(document.querySelectorAll('path[fill-rule="evenodd"]').length, 3);
});

test("saved-key badges preserve independent keyholes beside hidden settings cards", () => {
  const svg = functionalIconSvg("KeyRound", 14);
  const { document } = parseHTML(`<html><body><div hidden>${svg}</div>${svg}${functionalIconSvg("Key", 14)}</body></html>`);
  assert.equal(document.querySelectorAll("[id], [mask], defs").length, 0);
  assert.equal(document.querySelectorAll('path[fill-rule="evenodd"]').length, 3);
});

test("filled-adapter call sites retain stable desktop icon identifiers", () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
  for (const file of walk("src/renderer/src").filter(f => f.endsWith(".ts") && !f.includes(".test.") && !f.endsWith("functionalIconNames.ts"))) {
    const source = readFileSync(file, "utf8");
    // Original-icon surfaces can use new Lucide glyphs without creating a custom filled draft.
    if (!/import\s*\{[^}]*\bcreateLucideIcon\b[^}]*\}\s*from\s*["'](?:[^"']*\/ui\/icons|\.\/icons)\.js["']/s.test(source)) continue;
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']lucide["']/g)) {
      for (const raw of match[1]!.split(",")) {
        const name = raw.trim().split(/\s+/)[0]!;
        const value = (lucide as unknown as Record<string, unknown>)[name];
        if (!Array.isArray(value)) continue;
        assert.ok(desktopFunctionalIconNames.has(value as lucide.IconNode), `${file}: ${name} has no shared artwork`);
      }
    }
  }
});

test("desktop adapters render the exact shared artwork", () => {
  const { document } = parseHTML("<html><body></body></html>");
  const previous = globalThis.document;
  globalThis.document = document;
  try {
    for (const [node, name] of desktopFunctionalIconNames) {
      const el = createLucideIcon(node, { size: 14 });
      const expected = document.createElement("template");
      expected.innerHTML = node === lucide.RefreshCw
        ? originalIconSvg("RefreshCw", 14)
        : functionalIconSvg(name, 14);
      const unscoped = el.outerHTML.replace(/-i\d+(?=[")])/g, "");
      assert.equal(unscoped, expected.content.firstElementChild!.outerHTML, name);
      assert.equal(el.getAttribute("width"), "14");
    }
  } finally { globalThis.document = previous; }
});

test("desktop masked icons get per-copy ids so a hidden copy cannot blank the others", () => {
  const { document } = parseHTML("<html><body></body></html>");
  const previous = globalThis.document;
  globalThis.document = document;
  try {
    const first = createLucideIcon(lucide.RotateCcwClock, { size: 12 });
    const second = createLucideIcon(lucide.RotateCcwClock, { size: 12 });
    const firstId = first.querySelector("mask")!.id;
    const secondId = second.querySelector("mask")!.id;
    assert.notEqual(firstId, secondId);
    for (const [svg, id] of [[first, firstId], [second, secondId]] as const) {
      const refs = Array.from(svg.querySelectorAll("[mask]"), (n) => n.getAttribute("mask"));
      assert.ok(refs.length > 0);
      assert.ok(refs.every((ref) => ref === `url(#${id})`));
    }
  } finally { globalThis.document = previous; }
});

test("desktop tool cards and Thinking hints retain their original artwork", () => {
  const { document } = parseHTML("<html><body></body></html>");
  const previous = globalThis.document;
  globalThis.document = document;
  try {
    for (const [name, meta] of Object.entries(toolIconCatalog)) {
      const expected = document.createElement("template");
      expected.innerHTML = originalIconSvg(meta.icon, 16);
      assert.equal(createOriginalIcon(getToolDisplayMeta(name).icon, { size: 16 }).outerHTML, expected.content.firstElementChild!.outerHTML, name);
    }
  } finally { globalThis.document = previous; }
});

test("removed filled drafts fall back to originals without restoring discarded artwork", () => {
  assert.equal(Object.hasOwn(functionalIconArtwork, "Brain"), false);
  assert.equal(Object.hasOwn(functionalIconArtwork, "RefreshCw"), false);
  assert.equal(Object.hasOwn(functionalIconArtwork, "Code2"), false);
  assert.equal(functionalIconSvg("Brain", 14), originalIconSvg("Brain", 14));
  assert.equal(functionalIconSvg("RefreshCw", 14), originalIconSvg("RefreshCw", 14));
  assert.equal(functionalIconSvg("Code2", 14), functionalIconSvg("Code", 14));
});
