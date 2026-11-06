import assert from "node:assert/strict";
import Module from "node:module";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { FileText, SquareTerminal, Wrench } from "lucide";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] =
  () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});
// Real motion is browser-verified; DOM tests exercise instant state and a controlled drain race.

describe("resolveToolHint", () => {
  it("splits the label boundary and maps the tool icon", async () => {
    const { resolveToolHint: resolve } = await import("./toolDisplay.js");
    const read = resolve("Read File a.ts");
    assert.equal(read.icon, FileText);
    assert.equal(read.text, "a.ts");
    const shell = resolve("Shell npm test --grep reasoning");
    assert.equal(shell.icon, SquareTerminal);
    assert.equal(shell.text, "npm test --grep reasoning");
  });

  it("keeps the full text for label-only and unknown hints", async () => {
    const { resolveToolHint: resolve } = await import("./toolDisplay.js");
    assert.equal(resolve("Update Plan").text, "Update Plan");
    const unknown = resolve("Weird Tool with detail");
    assert.equal(unknown.icon, Wrench);
    assert.equal(unknown.text, "Weird Tool with detail");
  });

  it("routes MCP hints to the server icon and strips the prefix", async () => {
    const { resolveToolHint: resolve } = await import("./toolDisplay.js");
    const mcp = resolve("MCP : github create_issue");
    assert.equal(mcp.text, "github create_issue");
  });
});

for (const [port, load] of [
  ["desktop", () => import("./ReasoningBlockView.js")],
  ["relay", () => import("../../../../../../relay/web/src/reasoningBlock.js")],
] as const) describe(`${port} reasoning tool dock`, () => {
  it("retains the original outline icons in the heading and tool hints", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({ text: "Working", mode: "streaming", toolHints: ["Read File a.ts"] });
    const icons = [...root.querySelectorAll("svg")];
    assert.ok(icons.length >= 4);
    for (const svg of icons) {
      assert.equal(svg.getAttribute("fill"), "none");
      assert.equal(svg.getAttribute("stroke"), "currentColor");
      assert.equal(svg.hasAttribute("data-functional-icon"), false);
    }
    assert.equal(root.querySelector(".conversation-reasoning-chip-icon")?.getAttribute("stroke-width"), "2");
  });
  it("keeps four history circles and only the newest label, within the row budget", async () => {
    const mod = await load();
    const hints = ["a1", "a2", "a3", "a4", "a5", "a6"];
    const root = mod.createReasoningBlock({ text: "", mode: "streaming", toolHints: hints });
    const chips = [...root.querySelectorAll<HTMLElement>(".conversation-reasoning-chip")];
    assert.deepEqual(chips.map(c => c.dataset.hint), hints.slice(1));
    assert.deepEqual(chips.map(c => c.classList.contains("is-icon-only")), [true, true, true, true, false]);
    assert.equal(chips[0]?.style.width, "24px");
    assert.equal(root.querySelector(".conversation-reasoning-chips-count")?.textContent, "+1");
    assert.equal(root.querySelector(".conversation-reasoning-chips-count")?.parentElement, chips.at(-1));
    assert.equal(root.querySelector(".conversation-reasoning-tools")?.getAttribute("title"), hints.join("\n"));
    assert.deepEqual(mod.reasoningBlockToolHints(root), hints);
  });

  it("moves a recurring tool to the newest slot and ignores identical refreshes", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({ text: "", mode: "streaming" });
    const hints = ["Shell npm test", "Read File a.ts", "Shell npm test"];
    mod.setReasoningBlockToolHints(root, hints);
    const chips = [...root.querySelectorAll<HTMLElement>(".conversation-reasoning-chip")];
    assert.deepEqual(chips.map(c => c.dataset.hint), ["Read File a.ts", "Shell npm test"]);
    assert.equal(root.querySelector(".conversation-reasoning-chips-count")?.textContent, "+1");
    mod.setReasoningBlockToolHints(root, hints);
    assert.deepEqual([...root.querySelectorAll(".conversation-reasoning-chip")], chips);
    assert.equal(root.querySelector(".conversation-reasoning-chips-count")?.parentElement?.dataset.hint, "Shell npm test");
  });

  it("clears the dock after Thinking and retains the expandable tool record", async () => {
    const mod = await load();
    const hints = ["Read File a.ts", "Shell npm test"];
    const root = mod.createReasoningBlock({ text: "", mode: "streaming", toolHints: hints });
    mod.finalizeReasoningBlock(root);
    assert.equal(root.dataset.toolChipsPhase, "done");
    assert.equal(root.querySelectorAll(".conversation-reasoning-chip").length, 0);
    assert.equal(root.querySelector<HTMLElement>(".conversation-reasoning-tools")?.hidden, true);
    assert.deepEqual(mod.reasoningBlockToolHints(root), hints);
    // Hints-only fallback (no records): the structured record list replaces
    // the old plain-text join inside the body, visible once finalized.
    const log = root.querySelector<HTMLElement>(".conversation-reasoning-toollog");
    assert.ok(log, "tool record section exists");
    assert.equal(log.hidden, false, "record visible after finalize");
    const rows = [...root.querySelectorAll<HTMLElement>(".conversation-reasoning-toollog-row")];
    assert.equal(rows.length, 2);
    assert.match(log.textContent ?? "", /Tools/);
    assert.match(rows[0]?.textContent ?? "", /Read File/);
    assert.match(rows[0]?.textContent ?? "", /a\.ts/);
    assert.match(rows[1]?.textContent ?? "", /Shell/);
    assert.match(rows[1]?.textContent ?? "", /npm test/);
    mod.resumeReasoningBlockStreaming(root);
    assert.equal(root.querySelectorAll(".conversation-reasoning-chip").length, 2);
    assert.equal(root.querySelector<HTMLElement>(".conversation-reasoning-tools")?.hidden, false);
    assert.equal(root.querySelector<HTMLElement>(".conversation-reasoning-toollog")?.hidden, true,
      "record hides again while live");
  });

  it("renders per-call records with ×N merge, durations and failure tint", async () => {
    const mod = await load();
    const records = [
      { id: "r1", hint: "Read File a.ts", durationMs: 300 },
      { id: "r2", hint: "Read File a.ts", durationMs: 150 },
      { id: "g1", hint: "Shell npm test", durationMs: 8400, failed: true },
    ];
    const root = mod.createReasoningBlock({
      text: "thinking",
      mode: "collapsed",
      toolRecords: records,
    });
    assert.deepEqual(mod.reasoningBlockToolRecords(root), records);
    const rows = [...root.querySelectorAll<HTMLElement>(".conversation-reasoning-toollog-row")];
    assert.equal(rows.length, 2, "consecutive repeats merge into one row");
    assert.match(rows[0]?.textContent ?? "", /×2/);
    assert.match(rows[0]?.textContent ?? "", /0.5s/, "merged durations sum (300+150ms)");
    assert.match(rows[1]?.textContent ?? "", /8.4s/);
    assert.equal(rows[1]?.classList.contains("is-failed"), true);
    assert.equal(root.querySelector(".conversation-reasoning-toollog-count")?.textContent,
      "· 3 calls", "count reports calls, not merged rows");
    // Upsert by id replaces the record (live finish stamps duration).
    mod.upsertReasoningToolRecord(root, { id: "r2", hint: "Read File a.ts", durationMs: 900 });
    assert.equal(root.querySelectorAll(".conversation-reasoning-toollog-row").length, 2);
    assert.match(root.querySelector(".conversation-reasoning-toollog-row")?.textContent ?? "", /1.2s/);
  });

  it("keeps the record hidden while streaming and shows it at finalize", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({
      text: "",
      mode: "streaming",
      toolRecords: [{ id: "r1", hint: "Read File a.ts", durationMs: 200 }],
    });
    const log = root.querySelector<HTMLElement>(".conversation-reasoning-toollog");
    assert.ok(log, "record rendered into the body");
    assert.equal(log.hidden, true, "hidden while streaming");
    mod.finalizeReasoningBlock(root);
    assert.equal(root.querySelector<HTMLElement>(".conversation-reasoning-toollog")?.hidden, false);
  });

  it("does not replay the dock when loading a finished transcript", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({ text: "", mode: "collapsed", toolHints: ["Read File a.ts"] });
    assert.equal(root.querySelectorAll(".conversation-reasoning-chip").length, 0);
    assert.equal(root.querySelector<HTMLElement>(".conversation-reasoning-tools")?.hidden, true);
    assert.equal(root.querySelector(".conversation-reasoning-toollog-count")?.textContent,
      "· 1 call", "hint fallback counts calls");
    assert.match(root.querySelector(".conversation-reasoning-toollog-row")?.textContent ?? "", /Read File/);
  });

  it("flushes batched arrivals at finish and cancels an old drain when Thinking resumes", async () => {
    const mod = await load();
    const prototype = dom.HTMLElement.prototype as unknown as { animate?: unknown };
    const previous = prototype.animate;
    const pending: Array<{ resolve: () => void }> = [];
    prototype.animate = () => {
      let resolve!: () => void;
      const finished = new Promise<void>(done => { resolve = done; });
      pending.push({ resolve });
      return { finished, cancel: resolve };
    };
    const root = mod.createReasoningBlock({ text: "", mode: "streaming", toolHints: ["Read File a.ts", "Read File b.ts"] });
    document.body.append(root);
    try {
      mod.setReasoningBlockToolHints(root, ["Read File a.ts", "Read File b.ts", "Read File newest.ts"]);
      mod.finalizeReasoningBlock(root);
      assert.equal(root.dataset.toolChipsPhase, "draining");
      assert.equal(root.querySelector<HTMLElement>(".conversation-reasoning-chip.is-current")?.dataset.hint, "Read File newest.ts");
      mod.resumeReasoningBlockStreaming(root);
      const resumed = [...root.querySelectorAll(".conversation-reasoning-chip")];
      for (const animation of pending) animation.resolve();
      await new Promise<void>(done => setTimeout(done, 0));
      assert.equal(root.dataset.toolChipsPhase, "live");
      assert.equal(root.querySelector<HTMLElement>(".conversation-reasoning-tools")?.hidden, false);
      assert.equal(resumed.length, 3);
      assert.ok(resumed.every(node => node.parentElement?.classList.contains("conversation-reasoning-chips")));
    } finally {
      root.remove();
      if (previous === undefined) delete prototype.animate;
      else prototype.animate = previous;
    }
  });

  it("clears all pills when hints are reset", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({ text: "", mode: "streaming", toolHints: ["Read File a.ts"] });
    mod.setReasoningBlockToolHints(root, []);
    assert.equal(root.querySelectorAll(".conversation-reasoning-chip").length, 0);
    assert.equal(root.querySelector<HTMLElement>(".conversation-reasoning-tools")?.hidden, true);
  });

  it("finishes immediately when reduced motion is requested", async () => {
    const mod = await load();
    const prototype = dom.HTMLElement.prototype as unknown as { animate?: unknown };
    const previousAnimate = prototype.animate;
    const previousMedia = dom.window.matchMedia;
    prototype.animate = () => { throw new Error("reduced motion must not animate"); };
    dom.window.matchMedia = () => ({ matches: true }) as MediaQueryList;
    const root = mod.createReasoningBlock({ text: "", mode: "streaming", toolHints: ["Read File a.ts"] });
    document.body.append(root);
    try {
      mod.setReasoningBlockToolHints(root, ["Read File a.ts", "Read File b.ts"]);
      mod.finalizeReasoningBlock(root);
      assert.equal(root.dataset.toolChipsPhase, "done");
      assert.equal(root.querySelectorAll(".conversation-reasoning-chip").length, 0);
    } finally {
      root.remove();
      if (previousAnimate === undefined) delete prototype.animate;
      else prototype.animate = previousAnimate;
      dom.window.matchMedia = previousMedia;
    }
  });

  it("keeps a content-less block inert — click never expands, before and after finalize", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({ text: "", mode: "streaming" });
    const toggle = root.querySelector<HTMLElement>(".conversation-reasoning-toggle")!;
    assert.ok(root.classList.contains("is-empty"), "status-only shell is marked empty");
    toggle.click();
    assert.equal(root.classList.contains("is-open"), false, "empty shell does not expand");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    mod.finalizeReasoningBlock(root);
    assert.ok(root.classList.contains("is-empty"), "finalized empty Thought stays inert");
    toggle.click();
    assert.equal(root.classList.contains("is-open"), false);
    assert.equal(root.dataset.mode, "collapsed", "mode untouched by the blocked click");
  });

  it("becomes expandable the moment body content arrives", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({ text: "", mode: "streaming", startOpen: true });
    const toggle = root.querySelector<HTMLElement>(".conversation-reasoning-toggle")!;
    assert.equal(root.classList.contains("is-open"), false, "startOpen on an empty block is ignored");
    mod.setReasoningBlockText(root, "planning the fix ");
    assert.equal(root.classList.contains("is-empty"), false);
    toggle.click();
    assert.equal(root.classList.contains("is-open"), true, "block with CoT expands");
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    toggle.click();
    assert.equal(root.classList.contains("is-open"), false);
  });

  it("a hints-only streaming block stays inert until finalize shows the record", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({ text: "", mode: "streaming", toolHints: ["Read File a.ts"] });
    const toggle = root.querySelector<HTMLElement>(".conversation-reasoning-toggle")!;
    assert.ok(root.classList.contains("is-empty"), "the hidden record does not count while streaming");
    toggle.click();
    assert.equal(root.classList.contains("is-open"), false, "a blank body never expands");
    mod.finalizeReasoningBlock(root);
    assert.equal(root.classList.contains("is-empty"), false, "record becomes visible at finalize");
    toggle.click();
    assert.equal(root.classList.contains("is-open"), true);
    mod.setReasoningBlockToolHints(root, []);
    assert.equal(root.classList.contains("is-open"), false, "open block closes when its body empties");
    assert.ok(root.classList.contains("is-empty"), "hints cleared with no CoT back to inert");
  });

  it("painted CoT keeps a streaming block expandable while the record stays hidden", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({
      text: "",
      mode: "streaming",
      toolRecords: [{ id: "r1", hint: "Shell npm test" }],
    });
    assert.ok(root.classList.contains("is-empty"), "record alone does not expand a live block");
    mod.setReasoningBlockText(root, "planning the steps ");
    assert.equal(root.classList.contains("is-empty"), false, "painted CoT expands it");
    const toggle = root.querySelector<HTMLElement>(".conversation-reasoning-toggle")!;
    toggle.click();
    assert.equal(root.classList.contains("is-open"), true);
  });

  it("resuming streaming re-hides the record and re-evaluates expandability", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({
      text: "",
      mode: "streaming",
      toolRecords: [{ id: "r1", hint: "Shell npm test" }],
    });
    mod.finalizeReasoningBlock(root);
    assert.equal(root.classList.contains("is-empty"), false, "finalized record shows");
    mod.resumeReasoningBlockStreaming(root);
    assert.ok(root.classList.contains("is-empty"), "record hidden again — blank body inert");
    const toggle = root.querySelector<HTMLElement>(".conversation-reasoning-toggle")!;
    toggle.click();
    assert.equal(root.classList.contains("is-open"), false, "no expand over a blank body");
  });

  it("a pure-CoT snapshot block (no hints/records) is expandable", async () => {
    // Regression: the empty-state sync once ran while the body was still
    // detached from the root, so every transcript-rebuilt Thought got stuck
    // is-empty — visible meta (tokens/duration) but clicks did nothing.
    const mod = await load();
    const root = mod.createReasoningBlock({
      text: "a chain of thought",
      mode: "collapsed",
      stats: { durationMs: 1200, tokenCount: 40 },
    });
    assert.equal(root.classList.contains("is-empty"), false, "attached CoT body counts as content");
    const toggle = root.querySelector<HTMLElement>(".conversation-reasoning-toggle")!;
    toggle.click();
    assert.equal(root.classList.contains("is-open"), true, "click expands the pure-CoT block");
    assert.match(root.querySelector(".conversation-reasoning-cot")?.textContent ?? "", /chain of thought/);
  });

  it("an empty snapshot block stays inert", async () => {
    const mod = await load();
    const root = mod.createReasoningBlock({ text: "", mode: "collapsed" });
    assert.ok(root.classList.contains("is-empty"), "no content → inert");
    const toggle = root.querySelector<HTMLElement>(".conversation-reasoning-toggle")!;
    toggle.click();
    assert.equal(root.classList.contains("is-open"), false, "empty block never opens");
  });
});
