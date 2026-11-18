import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { CompactLanguagePopoverView } from "./CompactLanguagePopoverView.js";

test("native popovers update titles, copy only signatures, and relayout expanded docs", async () => {
  const { window, document } = parseHTML('<html><body><div id="host"><div class="monaco-hover"><div class="markdown-hover"><h4>TryAddItem</h4><pre><code>bool TryAddItem(int32 Count)</code></pre><details><summary>More details</summary>Full documentation</details></div><button class="hover-copy-button">Copy</button></div><div class="parameter-hints-widget"><div class="body"><div class="signature"><div class="code">bool UInventoryComponent::TryAddItem(int32 Count)</div></div><div class="docs"></div></div></div></div></body></html>');
  Object.assign(globalThis, { window, document, Element: window.Element, MutationObserver: window.MutationObserver });
  const copied: string[] = [];
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (s: string) => { copied.push(s); } } } });
  let layouts = 0;
  const editor = { getContribution: () => ({ _contentWidget: { widget: { handleContentsChanged: () => layouts++ } } }) };
  const host = document.getElementById("host")!;
  const view = new CompactLanguagePopoverView(host, editor as any);
  assert.equal(host.querySelector(".devmode-parameter-title")?.textContent, "ƒ  TryAddItem");
  assert.equal(host.querySelector(".hover-copy-button")?.getAttribute("aria-label"), "Copy signature");
  host.querySelector<HTMLButtonElement>(".hover-copy-button")!.click();
  await Promise.resolve();
  assert.deepEqual(copied, ["bool TryAddItem(int32 Count)"]);
  host.querySelector("details")!.dispatchEvent(new window.Event("toggle", { bubbles: true }));
  assert.equal(layouts, 2);
  host.querySelector(".signature .code")!.textContent = "void Reset()";
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(host.querySelector(".devmode-parameter-title")?.textContent, "ƒ  Reset");
  view.destroy();
  host.querySelector<HTMLButtonElement>(".hover-copy-button")!.click();
  await Promise.resolve();
  assert.equal(copied.length, 1);
});
