import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window });

function motionFixture() {
  const prototype = dom.HTMLElement.prototype;
  const previousAnimate = prototype.animate;
  const previousRect = prototype.getBoundingClientRect;
  const previousMedia = dom.window.matchMedia;
  const pending: Array<{ resolve: () => void; node: HTMLElement }> = [];
  const listeners = new Set<() => void>();
  const media = {
    matches: false,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  };
  dom.window.matchMedia = () => media as unknown as MediaQueryList;
  prototype.getBoundingClientRect = function () {
    const width = Array.from(this.textContent ?? "").length * 6;
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: 18, width, height: 18, toJSON() {} };
  };
  prototype.animate = function () {
    let resolve!: () => void;
    const finished = new Promise<void>(done => { resolve = done; });
    pending.push({ resolve, node: this });
    return { finished, cancel: resolve } as unknown as Animation;
  };
  const title = document.createElement("span");
  title.textContent = "Thinking";
  document.body.append(title);
  return {
    title, pending, media, listeners,
    reduce() { media.matches = true; for (const listener of listeners) listener(); },
    async finish() {
      for (const animation of pending) animation.resolve();
      await new Promise<void>(done => setTimeout(done, 0));
    },
    restore() {
      title.remove();
      prototype.animate = previousAnimate;
      prototype.getBoundingClientRect = previousRect;
      dom.window.matchMedia = previousMedia;
    },
  };
}

for (const [port, load] of [
  ["desktop", () => import("./reasoningTitle.js")],
  ["relay", () => import("../../../../relay/web/src/reasoningTitle.js")],
] as const) describe(`${port} Thinking title transition`, () => {
  it("keeps the latest text available and ignores repeated metadata refreshes", async () => {
    const { setReasoningTitle } = await load();
    const fixture = motionFixture();
    try {
      setReasoningTitle(fixture.title, "Searching files");
      const glyphs = [...fixture.title.children];
      const animationCount = fixture.pending.length;
      assert.ok(animationCount > 1);
      assert.equal(fixture.title.textContent, "Searching files");
      assert.equal(fixture.title.getAttribute("aria-label"), "Searching files");
      assert.ok(fixture.title.querySelector(".reasoning-title-previous[aria-hidden='true']"));
      for (let i = 0; i < 50; i++) setReasoningTitle(fixture.title, "Searching files");
      assert.deepEqual([...fixture.title.children], glyphs);
      assert.equal(fixture.pending.length, animationCount);
      await fixture.finish();
      assert.equal(fixture.title.textContent, "Searching files");
      assert.equal(fixture.title.childElementCount, 0);
      assert.equal(fixture.title.hasAttribute("aria-label"), false);
      assert.equal(fixture.title.classList.contains("is-title-transitioning"), false);
      assert.equal(fixture.title.style.width, "");
      assert.equal(fixture.listeners.size, 0);
    } finally { await fixture.finish(); fixture.restore(); }
  });

  it("keeps an in-flow baseline anchor while rolling", async () => {
    const { setReasoningTitle } = await load();
    const fixture = motionFixture();
    try {
      setReasoningTitle(fixture.title, "Searching files");
      // The anchor re-creates the in-flow line box (empty inline-blocks
      // baseline-snap to their bottom edge and shifted inline hosts); it
      // must be hidden and contribute nothing to textContent.
      const anchor = fixture.title.querySelector(".reasoning-title-anchor");
      assert.ok(anchor, "anchor span present during transition");
      assert.equal(anchor.getAttribute("aria-hidden"), "true");
      assert.equal(anchor.textContent, "");
      assert.equal(fixture.title.textContent, "Searching files");
      await fixture.finish();
      assert.equal(fixture.title.querySelector(".reasoning-title-anchor"), null);
    } finally { await fixture.finish(); fixture.restore(); }
  });

  it("does not let an interrupted transition overwrite a newer status or Thought", async () => {
    const { setReasoningTitle } = await load();
    const fixture = motionFixture();
    try {
      setReasoningTitle(fixture.title, "Searching files");
      const stale = [...fixture.pending];
      setReasoningTitle(fixture.title, "正在读取文件");
      for (const animation of stale) animation.resolve();
      await new Promise<void>(done => setTimeout(done, 0));
      assert.equal(fixture.title.textContent, "正在读取文件");
      assert.equal(fixture.title.classList.contains("is-title-transitioning"), true);
      setReasoningTitle(fixture.title, "Thought");
      await fixture.finish();
      assert.equal(fixture.title.textContent, "Thought");
      assert.equal(fixture.title.childElementCount, 0);
    } finally { await fixture.finish(); fixture.restore(); }
  });

  it("keeps Chinese, combining marks and emoji intact", async () => {
    const { setReasoningTitle } = await load();
    const fixture = motionFixture();
    try {
      const next = "检查 👩‍💻 e\u0301";
      setReasoningTitle(fixture.title, next);
      const characters = [...fixture.title.querySelectorAll<HTMLElement>(".reasoning-title-glyph:not(.reasoning-title-previous)")]
        .map(glyph => glyph.textContent);
      assert.deepEqual(characters, ["检", "查", " ", "👩‍💻", " ", "e\u0301"]);
      assert.equal(fixture.title.textContent, next);
    } finally { await fixture.finish(); fixture.restore(); }
  });

  it("skips initial/detached/reduced-motion animation and settles a running one when motion is reduced", async () => {
    const { setReasoningTitle } = await load();
    const fixture = motionFixture();
    try {
      fixture.title.remove();
      setReasoningTitle(fixture.title, "Reading files");
      assert.equal(fixture.pending.length, 0);
      document.body.append(fixture.title);
      fixture.title.textContent = "";
      setReasoningTitle(fixture.title, "Thinking");
      assert.equal(fixture.pending.length, 0);
      fixture.media.matches = true;
      setReasoningTitle(fixture.title, "Searching files");
      assert.equal(fixture.pending.length, 0);
      fixture.media.matches = false;
      setReasoningTitle(fixture.title, "Running checks");
      assert.ok(fixture.pending.length > 0);
      fixture.reduce();
      assert.equal(fixture.title.textContent, "Running checks");
      assert.equal(fixture.title.childElementCount, 0);
      assert.equal(fixture.listeners.size, 0);
    } finally { await fixture.finish(); fixture.restore(); }
  });
});
