import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  loadBreakpoints,
  parseBreakpoints,
  saveBreakpoints,
  serializeBreakpoints,
} from "./breakpointStore.js";

class MemoryStorage implements Storage {
  readonly #map = new Map<string, string>();
  get length(): number {
    return this.#map.size;
  }
  clear(): void {
    this.#map.clear();
  }
  getItem(key: string): string | null {
    return this.#map.has(key) ? this.#map.get(key)! : null;
  }
  key(index: number): string | null {
    return [...this.#map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.#map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }
}

const previousLocalStorage = (globalThis as { localStorage?: Storage })
  .localStorage;

function installStorage(store: Storage | null): void {
  if (store === null) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    (globalThis as { localStorage?: Storage }).localStorage = store;
  }
}

afterEach(() => {
  installStorage(previousLocalStorage ?? null);
});

describe("breakpointStore", () => {
  it("round-trips enabled state and migrates legacy rows as enabled", () => {
    const map = new Map([
      [
        "E:\\game\\Source\\A.cpp",
        new Map([
          [12, { condition: "x > 0", enabled: false }],
          [4, { condition: "", enabled: true }],
        ]),
      ],
    ]);
    const rows = serializeBreakpoints(map);
    assert.deepEqual(rows, [
      {
        path: "E:/game/Source/A.cpp",
        line: 4,
        condition: "",
        enabled: true,
      },
      {
        path: "E:/game/Source/A.cpp",
        line: 12,
        condition: "x > 0",
        enabled: false,
      },
    ]);
    const restored = parseBreakpoints({ version: 2, breakpoints: rows });
    assert.deepEqual(restored.get("E:/game/Source/A.cpp")?.get(12), {
      condition: "x > 0",
      enabled: false,
    });
    const legacy = parseBreakpoints({
      version: 1,
      breakpoints: [
        { path: "E:/game/Source/A.cpp", line: 4, condition: "" },
      ],
    });
    assert.deepEqual(legacy.get("E:/game/Source/A.cpp")?.get(4), {
      condition: "",
      enabled: true,
    });
  });

  it("loads and saves through localStorage keyed by workspace", () => {
    installStorage(new MemoryStorage());
    const workspace = "E:\\Project.NF";
    const map = new Map([
      [
        "E:/Project.NF/Source/Foo.cpp",
        new Map([[8, { condition: "", enabled: false }]]),
      ],
    ]);
    saveBreakpoints(workspace, map);
    const loaded = loadBreakpoints(workspace);
    assert.deepEqual(loaded.get("E:/Project.NF/Source/Foo.cpp")?.get(8), {
      condition: "",
      enabled: false,
    });
    saveBreakpoints(workspace, new Map());
    assert.equal(loadBreakpoints(workspace).size, 0);
  });
});
