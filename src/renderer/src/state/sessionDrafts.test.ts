import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  clearSessionDraft,
  getSessionDraft,
  setSessionDraft,
} from "./sessionDrafts.js";

/** Map-backed Storage stub — installed on globalThis per test. */
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

describe("sessionDrafts", () => {
  it("round-trips draft text per session key", () => {
    installStorage(new MemoryStorage());
    setSessionDraft("session-a", "帮我改一下 context cache");
    setSessionDraft("session-b", "another draft");
    assert.equal(getSessionDraft("session-a"), "帮我改一下 context cache");
    assert.equal(getSessionDraft("session-b"), "another draft");
    assert.equal(getSessionDraft("session-c"), "");
  });

  it("keeps intra-text whitespace but drops whitespace-only drafts", () => {
    installStorage(new MemoryStorage());
    setSessionDraft("session-a", "line one\nline two  ");
    assert.equal(getSessionDraft("session-a"), "line one\nline two  ");
    setSessionDraft("session-a", "   \n\t");
    assert.equal(getSessionDraft("session-a"), "");
  });

  it("clear removes the stash", () => {
    installStorage(new MemoryStorage());
    setSessionDraft("draft", "new task text");
    clearSessionDraft("draft");
    assert.equal(getSessionDraft("draft"), "");
  });

  it("oversize text is skipped, keeping the previous draft", () => {
    installStorage(new MemoryStorage());
    setSessionDraft("session-a", "small");
    setSessionDraft("session-a", "x".repeat(200_001));
    assert.equal(getSessionDraft("session-a"), "small");
  });

  it("absent storage never throws", () => {
    installStorage(null);
    assert.equal(getSessionDraft("session-a"), "");
    assert.doesNotThrow(() => setSessionDraft("session-a", "text"));
    assert.doesNotThrow(() => clearSessionDraft("session-a"));
  });
});
