/**
 * Shell fence marker + Light palette regression (Mac parity, user-confirmed
 * 2026-11-08 demos/shell-frame-light): relay console shell-language fences
 * carry `is-shell`; the Light theme paints those frames as the pale
 * #eef4fa recess (client --surface-2) with re-inked hljs tokens, while
 * untagged/source fences keep the dark code island. linkdom cannot compute
 * styles, so the palette half asserts the stylesheet source.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dom = parseHTML('<!doctype html><html lang="en" data-theme="light"><body></body></html>');
Object.assign(globalThis, {
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

const { parseMarkdownBlocks, renderMarkdownBlocks } = await import("../src/markdown.js");

function renderFences(markdown: string): HTMLElement[] {
  const container = document.createElement("div");
  renderMarkdownBlocks(parseMarkdownBlocks(markdown), container);
  return Array.from(container.querySelectorAll(".content-card-terminal"));
}

test("shell fences carry is-shell; untagged and source fences do not", () => {
  const pres = renderFences([
    "```bash",
    "$ npm run build",
    "```",
    "```ts",
    "const a = 1;",
    "```",
    "```",
    "plain untagged fence",
    "```",
  ].join("\n"));
  assert.equal(pres.length, 3, "three fences rendered");
  assert.match(pres[0]!.className, /(^|\s)is-shell(\s|$)/, "bash fence marked");
  assert.doesNotMatch(pres[1]!.className, /is-shell/, "ts fence stays dark island");
  assert.doesNotMatch(pres[2]!.className, /is-shell/, "untagged fence stays dark island");
});

test("shell fence body still renders highlighted code", () => {
  const [pre] = renderFences('```sh\necho "hi"\n```');
  assert.ok(pre, "fence rendered");
  const code = pre.querySelector("code");
  assert.ok(code, "code element present");
  assert.match(code!.className, /hljs/);
});

const css = readFileSync(
  fileURLToPath(new URL("../src/style.css", import.meta.url)),
  "utf8",
);

test("style.css: Light is-shell rule paints the pale recess with light inks", () => {
  const island = css.match(/html\[data-theme="light"\] \.content-card-terminal\s*\{[^}]*\}/);
  assert.ok(island, "base light island rule present");
  assert.match(island[0], /background:\s*var\(--code-surface\)/);

  const shell = css.match(/html\[data-theme="light"\] \.content-card-terminal\.is-shell\s*\{[^}]*\}/);
  assert.ok(shell, "is-shell light override present");
  assert.match(shell[0], /background:\s*#eef4fa/);
  assert.match(shell[0], /border-color:\s*rgba\(var\(--accent-rgb\),\s*0\.16\)/);
  assert.match(shell[0], /color:\s*var\(--fg\)/);

  const shellScoped = css.slice(css.indexOf(".content-card-terminal.is-shell"));
  assert.ok(shellScoped.length > 0, "is-shell rules exist");
  assert.match(shellScoped, /\.hljs-string/);
  assert.match(shellScoped, /#0a3069/);
  assert.match(shellScoped, /\.hljs-comment/);
  assert.match(shellScoped, /#59636e/);
});
