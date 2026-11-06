/**
 * Quick Open — progressive engine index.
 *
 * The project tier is awaited (small, and the palette is useless without it)
 * while the engine tier streams in behind it. These tests drive the real
 * search path and assert what the list shows as batches land.
 *
 * No `Worker` exists in this harness, so `QuickOpenSearchClient` falls back to
 * ranking in-thread — which also keeps the fallback path covered.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

type QuickOpenControllerT =
  typeof import("./QuickOpenController.js")["QuickOpenController"];
let QuickOpenController: QuickOpenControllerT;

test.before(async () => {
  ({ QuickOpenController } = await import("./QuickOpenController.js"));
});

const WORKSPACE = "E:/work/NF";

const PROJECT_FILES = [
  { path: `${WORKSPACE}/Source/Widget.h`, rel: "Source/Widget.h" },
  { path: `${WORKSPACE}/Source/Other.cpp`, rel: "Source/Other.cpp" },
];
const OTHER_WORKSPACE = "E:/work/Other";
const OTHER_PROJECT_FILES = [
  { path: `${OTHER_WORKSPACE}/Src/Widget.h`, rel: "Src/Widget.h" },
];
const ENGINE_BATCH = [
  {
    path: "E:/UE/Engine/Source/Runtime/Widget.h",
    rel: "Engine/Source/Runtime/Widget.h",
  },
  { path: "E:/UE/Engine/Source/Misc/Thing.h", rel: "Engine/Source/Misc/Thing.h" },
];

type IndexChunk = {
  requestId: number;
  files: Array<{ path: string; rel: string }>;
  done: boolean;
  truncated: boolean;
};

type Harness = {
  controller: InstanceType<QuickOpenControllerT>;
  /** Point the palette at a different workspace. */
  setRoot: (root: string) => void;
  /** Push a streamed batch as main would. */
  emit: (chunk: Partial<IndexChunk>) => void;
  /** Request ids main was asked to index under. */
  indexStarts: number[];
  /** Type into the palette and let the debounced search settle. */
  type: (text: string) => Promise<void>;
  /** Visible file rows, in order. */
  rows: () => string[];
  note: () => string;
};

/** Previous palette — torn down so stale rows cannot answer our queries. */
let mounted: InstanceType<QuickOpenControllerT> | null = null;

async function mountQuickOpen(): Promise<Harness> {
  mounted?.destroy();
  mounted = null;
  dom.document.body.replaceChildren();

  const indexStarts: number[] = [];
  let chunkHandler: ((chunk: IndexChunk) => void) | null = null;
  let root = WORKSPACE;

  Object.assign(window, {
    jellybot: {
      searchDevModeFiles: async () => ({
        ok: true as const,
        // A second workspace contributes its own, differently named file.
        files: root === WORKSPACE ? PROJECT_FILES : OTHER_PROJECT_FILES,
        truncated: false,
      }),
      startDevModeFileIndex: async (_root: string, requestId: number) => {
        indexStarts.push(requestId);
        return { ok: true };
      },
      cancelDevModeFileIndex: async () => undefined,
      onDevModeIndexChunk: (handler: (chunk: IndexChunk) => void) => {
        chunkHandler = handler;
        return () => {
          chunkHandler = null;
        };
      },
    },
  });

  const controller = new QuickOpenController({
    openFile: () => undefined,
    getWorkspaceRoot: () => root,
  });
  controller.mount(dom.document.body);
  mounted = controller;
  controller.open();

  const input = dom.document.querySelector(
    ".devmode-quickopen-input",
  ) as HTMLInputElement;
  assert.ok(input, "quick open input not mounted");

  return {
    controller,
    indexStarts,
    setRoot: (next: string) => {
      root = next;
    },
    emit: (chunk) =>
      chunkHandler?.({
        requestId: indexStarts[indexStarts.length - 1] ?? 1,
        files: [],
        done: false,
        truncated: false,
        ...chunk,
      }),
    type: async (text: string) => {
      input.value = text;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      // Clear the 150ms search debounce, then let the awaited walk resolve.
      await new Promise((resolve) => setTimeout(resolve, 220));
    },
    rows: () =>
      [
        ...dom.document.querySelectorAll(
          '.devmode-quickopen-item[data-kind="file"]',
        ),
      ].map((el) => el.querySelector(".devmode-quickopen-detail")?.textContent ?? ""),
    note: () =>
      dom.document.querySelector(".devmode-quickopen-note")?.textContent ?? "",
  };
}

/** Wait out the streamed-batch refresh throttle. */
const settleStream = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 450));

test("open(seed) prefills the query and runs the search (F12 fallback)", async () => {
  const { controller, rows, note } = await mountQuickOpen();

  // Re-open with a seed — the palette must search it without extra typing.
  controller.open("widget");
  await new Promise((resolve) => setTimeout(resolve, 220));
  assert.deepEqual(rows(), ["Source"]);
  assert.ok(note().length > 0, "seeded open still renders the meta note");
});

test("project hits answer before the engine index arrives", async () => {
  const { type, rows, indexStarts } = await mountQuickOpen();

  await type("widget");
  assert.deepEqual(rows(), ["Source"]);
  // The engine pass is kicked off by the same search, not awaited by it.
  assert.equal(indexStarts.length, 1);
});

test("streamed engine batches fold into the visible results", async () => {
  const { type, rows, emit } = await mountQuickOpen();

  await type("widget");
  assert.deepEqual(rows(), ["Source"]);

  emit({ files: ENGINE_BATCH });
  await settleStream();

  // Project code still leads; the engine hit joins below it.
  assert.deepEqual(rows(), ["Source", "Engine/Source/Runtime"]);
});

test("~engine narrows results to engine sources", async () => {
  const { type, rows, emit } = await mountQuickOpen();

  await type("widget");
  emit({ files: ENGINE_BATCH, done: true, truncated: false });
  await settleStream();

  await type("~engine widget");
  assert.deepEqual(rows(), ["Engine/Source/Runtime"]);

  // Dropping the prefix restores project hits without another walk.
  await type("widget");
  assert.deepEqual(rows(), ["Source", "Engine/Source/Runtime"]);
});

test("batches from a superseded walk are ignored", async () => {
  const { type, rows, emit } = await mountQuickOpen();

  await type("widget");
  emit({ requestId: 999, files: ENGINE_BATCH });
  await settleStream();

  assert.deepEqual(rows(), ["Source"]);
});

test("the engine index is requested once per workspace", async () => {
  const { type, indexStarts } = await mountQuickOpen();

  await type("widget");
  await type("widget h");
  await type("other");

  assert.equal(indexStarts.length, 1);
});

test("switching workspace drops the old index and re-runs the engine pass", async () => {
  const { type, rows, emit, setRoot, indexStarts } = await mountQuickOpen();

  await type("widget");
  emit({ files: ENGINE_BATCH, done: true, truncated: false });
  await settleStream();
  assert.deepEqual(rows(), ["Source", "Engine/Source/Runtime"]);

  setRoot(OTHER_WORKSPACE);
  await type("widget ");
  await type("widget");

  // Only the new workspace's file survives, and the engine pass restarts.
  assert.deepEqual(rows(), ["Src"]);
  assert.equal(indexStarts.length, 2);
});

test("late batches from the previous workspace are discarded", async () => {
  const { type, rows, emit, setRoot } = await mountQuickOpen();

  await type("widget");
  setRoot(OTHER_WORKSPACE);
  await type("widget ");
  await type("widget");

  // Replay a batch tagged with the superseded walk's id.
  emit({ requestId: 1, files: ENGINE_BATCH, done: true, truncated: false });
  await settleStream();

  assert.deepEqual(rows(), ["Src"]);
});

test("the meta note reports engine indexing, then truncation", async () => {
  const { type, emit, note } = await mountQuickOpen();

  await type("widget");
  assert.match(note(), /Indexing Engine/);

  emit({ files: ENGINE_BATCH, done: true, truncated: true });
  await settleStream();
  assert.match(note(), /Engine index incomplete/);
});
