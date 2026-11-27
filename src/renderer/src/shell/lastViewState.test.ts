import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  readLastView,
  resolveRestoreTarget,
  writeLastView,
} from "./lastViewState.js";

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

let store: MemoryStorage;

function installStorage(next: MemoryStorage | null): void {
  if (next === null) Reflect.deleteProperty(globalThis, "localStorage");
  else (globalThis as { localStorage?: Storage }).localStorage = next;
}

beforeEach(() => {
  store = new MemoryStorage();
  installStorage(store);
});

afterEach(() => {
  if (previousLocalStorage === undefined) {
    Reflect.deleteProperty(globalThis, "localStorage");
  } else {
    (globalThis as { localStorage?: Storage }).localStorage =
      previousLocalStorage;
  }
});

describe("lastViewState", () => {
  it("returns null before anything is stored", () => {
    assert.equal(readLastView(), null);
  });

  it("round-trips a dev mode view with a session", () => {
    writeLastView({
      mode: "dev",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      nav: null,
    });
    assert.deepEqual(readLastView(), {
      mode: "dev",
      sessionId: "session-1",
      workspaceId: "workspace-1",
      nav: null,
    });
  });

  it("round-trips a normal mode nav view", () => {
    writeLastView({
      mode: "normal",
      sessionId: null,
      workspaceId: null,
      nav: "skills",
    });
    assert.deepEqual(readLastView(), {
      mode: "normal",
      sessionId: null,
      workspaceId: null,
      nav: "skills",
    });
  });

  it("ignores corrupt records", () => {
    store.setItem("jellybot.shell.lastView.v1", "{not json");
    assert.equal(readLastView(), null);
    store.setItem("jellybot.shell.lastView.v1", JSON.stringify({ mode: "wide" }));
    assert.equal(readLastView(), null);
    store.setItem("jellybot.shell.lastView.v1", JSON.stringify(["dev"]));
    assert.equal(readLastView(), null);
  });

  it("drops unknown fields and invalid values", () => {
    store.setItem(
      "jellybot.shell.lastView.v1",
      JSON.stringify({
        mode: "normal",
        sessionId: 42,
        workspaceId: "",
        nav: "settings",
        extra: true,
      }),
    );
    assert.deepEqual(readLastView(), {
      mode: "normal",
      sessionId: null,
      workspaceId: null,
      nav: null,
    });
  });

  it("survives a missing localStorage", () => {
    installStorage(null);
    assert.equal(readLastView(), null);
    assert.doesNotThrow(() =>
      writeLastView({
        mode: "normal",
        sessionId: null,
        workspaceId: null,
        nav: "new-task",
      }),
    );
  });
});

describe("resolveRestoreTarget", () => {
  const sessions = [
    { id: "s1", workspaceId: "w1" },
    { id: "gone-archived", workspaceId: "w1", archived: true },
  ];

  it("restores the remembered session with its mode", () => {
    assert.deepEqual(
      resolveRestoreTarget(
        { mode: "dev", sessionId: "s1", workspaceId: "w1", nav: null },
        sessions,
      ),
      { kind: "session", sessionId: "s1", workspaceId: "w1", mode: "dev" },
    );
    assert.deepEqual(
      resolveRestoreTarget(
        { mode: "normal", sessionId: "s1", workspaceId: null, nav: null },
        sessions,
      ),
      { kind: "session", sessionId: "s1", workspaceId: "w1", mode: "normal" },
    );
  });

  it("falls back to the stored workspace when the session has none", () => {
    assert.deepEqual(
      resolveRestoreTarget(
        { mode: "normal", sessionId: "s9", workspaceId: "w7", nav: null },
        [{ id: "s9" }],
      ),
      { kind: "session", sessionId: "s9", workspaceId: "w7", mode: "normal" },
    );
  });

  it("ignores archived sessions", () => {
    assert.deepEqual(
      resolveRestoreTarget(
        {
          mode: "normal",
          sessionId: "gone-archived",
          workspaceId: "w1",
          nav: "new-task",
        },
        sessions,
      ),
      { kind: "nav", nav: "new-task" },
    );
  });

  it("restores dev mode without a session as a dev mode new task", () => {
    assert.deepEqual(
      resolveRestoreTarget(
        { mode: "dev", sessionId: null, workspaceId: "w3", nav: null },
        sessions,
      ),
      { kind: "dev-new-task", workspaceId: "w3" },
    );
    assert.deepEqual(
      resolveRestoreTarget(
        { mode: "dev", sessionId: "deleted", workspaceId: null, nav: null },
        sessions,
      ),
      { kind: "dev-new-task", workspaceId: null },
    );
  });

  it("restores the last nav screen in normal mode", () => {
    assert.deepEqual(
      resolveRestoreTarget(
        { mode: "normal", sessionId: null, workspaceId: null, nav: "loop" },
        sessions,
      ),
      { kind: "nav", nav: "loop" },
    );
  });

  it("reports nothing to restore when the record is empty", () => {
    assert.deepEqual(
      resolveRestoreTarget(
        { mode: "normal", sessionId: null, workspaceId: null, nav: null },
        sessions,
      ),
      { kind: "none" },
    );
  });
});
