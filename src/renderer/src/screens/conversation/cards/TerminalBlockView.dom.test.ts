/**
 * Shell fence marker + Light palette regression (user-confirmed 2026-11-08,
 * demos/shell-frame-light): shell-language terminal blocks carry `is-shell`
 * and the Light theme paints them as the pale --surface-2 recess instead of
 * the #0d0d0d code island. Untagged and source-language fences stay on the
 * dark island (github-dark tokens). linkdom cannot compute styles, so the
 * palette half asserts the stylesheet source.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { before, describe, it } from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })
  ._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
});

let createTerminalBlockView: typeof import("./TerminalBlockView.js")["createTerminalBlockView"];
before(async () => {
  ({ createTerminalBlockView } = await import("./TerminalBlockView.js"));
});

describe("shell fence marker (is-shell)", () => {
  it("marks every shell fence language, case-insensitive", () => {
    for (const language of ["bash", "sh", "shell", "zsh", "console", "terminal", "powershell", "ps1", "cmd", "bat", " BASH "]) {
      const pre = createTerminalBlockView("$ ls", language);
      assert.equal(
        pre.classList.contains("is-shell"),
        true,
        `${language} fence should carry is-shell`,
      );
    }
  });

  it("leaves untagged and source-language fences unmarked (dark island)", () => {
    for (const language of [undefined, "", "ts", "python", "json"]) {
      const pre = createTerminalBlockView("const a = 1;", language);
      assert.equal(
        pre.classList.contains("is-shell"),
        false,
        `${String(language)} fence must stay on the dark island`,
      );
    }
  });

  it("still highlights the body (pre > code.hljs)", () => {
    const pre = createTerminalBlockView('echo "hi"', "bash");
    const code = pre.querySelector("code");
    assert.ok(code, "code element present");
    assert.match(code!.className, /content-card-terminal-code/);
    assert.match(code!.className, /hljs/);
    assert.ok(code!.innerHTML.length > 0);
  });
});

const css = readFileSync(
  fileURLToPath(new URL("./content-cards-markdown.css", import.meta.url)),
  "utf8",
);

function ruleBlock(pattern: RegExp, label: string): string {
  const match = css.match(pattern);
  assert.ok(match, `missing rule: ${label}`);
  return match[0];
}

describe("Light shell-frame palette (stylesheet source)", () => {
  it("base fence body keeps the dark code island in every theme", () => {
    const block = ruleBlock(
      /\.content-card-code \.content-card-terminal\s*\{[^}]*\}/,
      ".content-card-code .content-card-terminal",
    );
    assert.match(block, /background:\s*var\(--code-surface\)/);
    assert.match(block, /border:\s*1px solid var\(--code-border\)/);
  });

  it("Light re-values only is-shell frames to the pale recess", () => {
    const block = ruleBlock(
      /:root\[data-theme="light"\]\s*\.content-card-code\s*\.content-card-terminal\.is-shell\s*\{[^}]*\}/,
      "light is-shell override",
    );
    assert.match(block, /background:\s*var\(--surface-2\)/);
    assert.match(block, /border-color:\s*rgba\(var\(--accent-rgb\),\s*0\.16\)/);
    assert.match(block, /color:\s*var\(--fg\)/);
  });

  it("re-inks hljs tokens to light-surface equivalents inside shell frames", () => {
    const tail = css.slice(css.indexOf(".content-card-terminal.is-shell"));
    assert.ok(tail.length > 0, "is-shell rules exist");
    assert.match(tail, /\.hljs-string/);
    assert.match(tail, /#0a3069/);
    assert.match(tail, /\.hljs-comment/);
    assert.match(tail, /#59636e/);
  });
});
