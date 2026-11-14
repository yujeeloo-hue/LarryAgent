import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import {
  applyFontScales,
  bootstrapFontScaleFromSettings,
  CHAT_FONT_SCALE_VAR,
  readFontScales,
} from "./fontScale.js";

describe("fontScale", () => {
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  let dom: ReturnType<typeof parseHTML>;
  let zoomCalls: number[];

  before(() => {
    dom = parseHTML("<!doctype html><html><body></body></html>");
    zoomCalls = [];
    Object.assign(globalThis, {
      document: dom.document,
      window: dom.window,
    });
    Object.assign(dom.window, {
      jellybot: {
        setUiZoomFactor: (factor: number) => {
          zoomCalls.push(factor);
        },
      },
    });
  });
  after(() => {
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
    if (originalWindow) {
      Object.defineProperty(globalThis, "window", originalWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  });

  it("chat scale sets the CSS var on <html>; 1 removes it", () => {
    applyFontScales({ chat: 1.25 });
    assert.equal(
      document.documentElement.style.getPropertyValue(CHAT_FONT_SCALE_VAR),
      "1.25",
    );
    assert.deepEqual(readFontScales(), { ui: 1, chat: 1.25 });
    applyFontScales({ chat: 1 });
    assert.equal(
      document.documentElement.style.getPropertyValue(CHAT_FONT_SCALE_VAR),
      "",
    );
    assert.equal(readFontScales().chat, 1);
  });

  it("ui scale goes through the webFrame bridge, clamped", () => {
    applyFontScales({ ui: 1.15 });
    applyFontScales({ ui: 99 });
    applyFontScales({ ui: Number.NaN });
    assert.deepEqual(zoomCalls.slice(-3), [1.15, 1.5, 1]);
    assert.equal(readFontScales().ui, 1);
  });

  it("chat scale clamps to 0.8–1.6", () => {
    applyFontScales({ chat: 2.5 });
    assert.equal(readFontScales().chat, 1.6);
    applyFontScales({ chat: 0.1 });
    assert.equal(readFontScales().chat, 0.8);
    applyFontScales({ chat: 1 });
  });

  it("bootstrap applies persisted scales from settings", async () => {
    Object.assign(dom.window, {
      jellybot: {
        setUiZoomFactor: (factor: number) => {
          zoomCalls.push(factor);
        },
        getWorkspaceSettings: async () => ({
          uiFontScale: 1.3,
          chatFontScale: 0.9,
        }),
      },
    });
    await bootstrapFontScaleFromSettings();
    assert.deepEqual(readFontScales(), { ui: 1.3, chat: 0.9 });
    assert.equal(zoomCalls.at(-1), 1.3);
    assert.equal(
      document.documentElement.style.getPropertyValue(CHAT_FONT_SCALE_VAR),
      "0.9",
    );
  });

  it("bootstrap degrades silently without a bridge", async () => {
    applyFontScales({ ui: 1, chat: 1 });
    Object.assign(dom.window, { jellybot: undefined });
    await bootstrapFontScaleFromSettings();
    // no settings → nothing applied, no throw
    assert.deepEqual(readFontScales(), { ui: 1, chat: 1 });
  });
});
