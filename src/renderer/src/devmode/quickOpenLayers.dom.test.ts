import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node });
const storage = new Map<string, string>();
Object.assign(window, {
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  },
});

type QuickOpenModule = typeof import("./QuickOpenController.js");
type ClangdModule = typeof import("./clangdFeatures.js");
let QuickOpenController: QuickOpenModule["QuickOpenController"];
let resetClangdAvailabilityCache: ClangdModule["resetClangdAvailabilityCache"];

test.before(async () => {
  ({ QuickOpenController } = await import("./QuickOpenController.js"));
  ({ resetClangdAvailabilityCache } = await import("./clangdFeatures.js"));
});

const ROOT = "/workspace/Atlas";
const settle = (ms = 240) => new Promise((resolve) => setTimeout(resolve, ms));

type TextChunk = {
  requestId: number;
  hits: Array<{ path: string; rel: string; line: number; column: number; preview: string }>;
  done: boolean;
  truncated: boolean;
  error?: string;
};

function harness() {
  storage.clear();
  document.body.replaceChildren();
  resetClangdAvailabilityCache();
  const textStarts: Array<{ requestId: number; query: string }> = [];
  let textCancels = 0;
  let textChunk: ((chunk: TextChunk) => void) | undefined;
  let indexChunk:
    | ((chunk: { requestId: number; files: unknown[]; done: boolean; truncated: boolean }) => void)
    | undefined;
  let releaseClangd: (() => void) | undefined;
  const clangdGate = new Promise<void>((resolve) => {
    releaseClangd = resolve;
  });
  const opened: Array<{ path: string; line: number | undefined }> = [];
  Object.assign(window, {
    jellybot: {
      getDevModeEngineRoot: async () => null,
      searchDevModeFiles: async () => ({
        ok: true,
        files: [{ path: `${ROOT}/Source/Hero.h`, rel: "Source/Hero.h" }],
        truncated: false,
      }),
      startDevModeFileIndex: async (_root: string, requestId: number) => {
        queueMicrotask(() => indexChunk?.({ requestId, files: [], done: true, truncated: false }));
        return { ok: true };
      },
      onDevModeIndexChunk: (handler: typeof indexChunk) => {
        indexChunk = handler;
        return () => {
          indexChunk = undefined;
        };
      },
      cancelDevModeFileIndex: async () => {},
      clangdReferences: async () => {},
      clangdDefinition: async () => {},
      clangdCancelQuery: async () => {},
      clangdHover: async () => {},
      clangdCompletion: async () => {},
      clangdSignatureHelp: async () => {},
      searchSymbols: async () => [
        { name: "HeroStats", kind: "struct", path: `${ROOT}/Source/HeroStats.h`, line: 4 },
      ],
      clangdStatus: async () => ({ ok: true }),
      clangdWorkspaceSymbols: async () => {
        await clangdGate;
        return {
          ok: true,
          symbols: [{ name: "Hero", path: `${ROOT}/Source/Hero.h`, line: 9, column: 7, symbolKind: "class" }],
        };
      },
      startDevModeTextSearch: async (_root: string, requestId: number, query: string) => {
        textStarts.push({ requestId, query });
        return { ok: true };
      },
      cancelDevModeTextSearch: async () => {
        textCancels++;
      },
      onDevModeTextSearchChunk: (handler: (chunk: TextChunk) => void) => {
        textChunk = handler;
        return () => {
          textChunk = undefined;
        };
      },
    },
  });
  const controller = new QuickOpenController({
    getWorkspaceRoot: () => ROOT,
    openFile: (path, line) => opened.push({ path, line }),
  });
  controller.mount(document.body);
  const input = document.querySelector<HTMLInputElement>(".devmode-quickopen-input")!;
  return {
    controller,
    opened,
    textStarts,
    textCancels: () => textCancels,
    emitText: (chunk: Partial<TextChunk>) =>
      textChunk?.({
        requestId: textStarts[textStarts.length - 1]?.requestId ?? 0,
        hits: [],
        done: false,
        truncated: false,
        ...chunk,
      }),
    releaseClangd: () => releaseClangd?.(),
    type: async (text: string) => {
      input.value = text;
      input.dispatchEvent(new dom.window.Event("input"));
      await settle();
    },
    rows: () =>
      [...document.querySelectorAll<HTMLElement>(".devmode-quickopen-item")].map(
        (row) => `${row.dataset.kind}:${row.querySelector(".devmode-quickopen-name")?.textContent}`,
      ),
    labels: () =>
      [...document.querySelectorAll(".devmode-quickopen-label")].map((el) => el.textContent),
    selected: () =>
      document.querySelector(".devmode-quickopen-item.is-sel .devmode-quickopen-name")?.textContent,
    tab: async (category: string) => {
      (document.querySelector(`[data-category="${category}"]`) as HTMLButtonElement).click();
      await settle();
    },
  };
}

test("fast layers render first; clangd lands on top when it arrives", async () => {
  const h = harness();
  try {
    h.controller.open();
    await h.type("hero");
    assert.deepEqual(h.rows(), ["symbol:HeroStats", "file:Hero.h"]);
    assert.equal(h.textStarts.length, 1);

    h.emitText({
      hits: [{ path: `${ROOT}/Docs/lore.md`, rel: "Docs/lore.md", line: 2, column: 5, preview: "The hero returns" }],
    });
    assert.deepEqual(h.rows(), ["symbol:HeroStats", "text:The hero returns", "file:Hero.h"]);

    h.releaseClangd();
    await settle(20);
    assert.deepEqual(h.rows(), [
      "symbol:Hero",
      "symbol:HeroStats",
      "text:The hero returns",
      "file:Hero.h",
    ]);
    assert.deepEqual(h.labels(), ["Semantic", "Symbols", "Text", "Files"]);
    assert.equal(h.selected(), "Hero");

    h.emitText({ done: true, truncated: true });
    assert.match(document.querySelector(".devmode-quickopen-note")?.textContent ?? "", /Text results limited/);
  } finally {
    h.controller.destroy();
  }
});

test("a picked row is kept when a more precise layer re-sorts the list", async () => {
  const h = harness();
  try {
    h.controller.open();
    await h.type("hero");
    const input = document.querySelector<HTMLInputElement>(".devmode-quickopen-input")!;
    input.dispatchEvent(Object.assign(new dom.window.Event("keydown"), { key: "ArrowDown" }));
    assert.equal(h.selected(), "Hero.h");
    h.releaseClangd();
    await settle(20);
    assert.equal(h.rows()[0], "symbol:Hero");
    assert.equal(h.selected(), "Hero.h");
  } finally {
    h.controller.destroy();
  }
});

test("the Text tab shows only text hits and opens them at their line", async () => {
  const h = harness();
  try {
    h.controller.open();
    await h.type("lore");
    await h.tab("Text");
    h.emitText({
      hits: [{ path: `${ROOT}/Docs/lore.md`, rel: "Docs/lore.md", line: 8, column: 1, preview: "lore line" }],
      done: true,
    });
    assert.deepEqual(h.rows(), ["text:lore line"]);
    assert.deepEqual(h.labels(), []);
    const input = document.querySelector<HTMLInputElement>(".devmode-quickopen-input")!;
    input.dispatchEvent(Object.assign(new dom.window.Event("keydown"), { key: "Enter" }));
    assert.deepEqual(h.opened, [{ path: `${ROOT}/Docs/lore.md`, line: 8 }]);
  } finally {
    h.controller.destroy();
  }
});

test("short queries skip text search, stale chunks are ignored, close cancels", async () => {
  const h = harness();
  try {
    h.controller.open();
    await h.type("he");
    assert.equal(h.textStarts.length, 0);

    await h.type("hero");
    assert.equal(h.textStarts.length, 1);
    await h.type("heroes");
    assert.equal(h.textStarts.length, 2);
    h.emitText({
      requestId: h.textStarts[0]!.requestId,
      hits: [{ path: `${ROOT}/old.txt`, rel: "old.txt", line: 1, column: 1, preview: "stale" }],
    });
    assert.ok(!h.rows().includes("text:stale"));

    h.controller.close();
    assert.equal(h.textCancels(), 1);
  } finally {
    h.controller.destroy();
  }
});

test("an unavailable text engine is reported without hiding other layers", async () => {
  const h = harness();
  try {
    h.controller.open();
    await h.type("hero");
    h.emitText({ done: true, error: "spawn rg ENOENT" });
    assert.match(document.querySelector(".devmode-quickopen-note")?.textContent ?? "", /Text search unavailable/);
    assert.ok(h.rows().includes("file:Hero.h"));
  } finally {
    h.controller.destroy();
  }
});
