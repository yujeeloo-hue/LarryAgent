/**
 * `/compact <keep>` store-level plumbing: the manual compact IPC accepts a
 * one-off protectTokenRatio override; the compaction walk honors it (a tiny
 * ratio summarizes rounds the default ratio would keep raw) and invalid
 * values are dropped at the trust boundary (behavior falls back to the
 * configured settings ratio).
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { configureFsmGraphsRoot } from "../agent/fsm/graphLibrary/manager.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { openSessionDb, upsertSession } from "../session/db/index.js";
import type { Message, Session } from "../session/types.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import type { WorkspaceSettings } from "../settings/types.js";
import { createSessionStore, type SessionStore } from "./sessionRuntime.js";

const stores: SessionStore[] = [];
after(() => {
  for (const store of stores) store.memorySync.stop();
});

/** Common one-token words repeated → ~9k o200k tokens per iteration. */
function bigBody(tag: string): string {
  return `the quick brown fox jumps over the lazy dog number ${tag} `.repeat(900);
}

function transcript(): Message[] {
  const messages: Message[] = [];
  for (let i = 1; i <= 3; i += 1) {
    messages.push({
      id: `u${i}`,
      role: "user",
      parts: [{ type: "text", text: `Request number ${i}` }],
      createdAt: i * 10,
    });
    messages.push({
      id: `a${i}`,
      role: "assistant",
      parts: [{ type: "text", text: bigBody(String(i)) }],
      createdAt: i * 10 + 1,
    });
  }
  return messages;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jellybot-compact-keep-"));
  configureUserMemoryRoot(root);
  configureCredentialsRoot(root);
  configureLegacyKeyBridgeForTests(null);
  configureFsmGraphsRoot(join(root, "graphs"));
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
  // 200k limit → default protect budget 0.2 × 200k = 40k tokens (three ~8k
  // iterations all stay raw); override 0.01 → 2k budget (the newest
  // iteration alone blows it, so everything is summarized).
  const settings: WorkspaceSettings = {
    providers: [
      { id: "p1", name: "One", baseUrl: "http://127.0.0.1:9/v1", modelId: "m1" },
    ],
    activeProviderId: "p1",
    composerRunMode: "agent",
    contextLimitTokens: 200_000,
    userMemoryAutoExtract: false,
    projectMemoryAutoExtract: false,
  };
  writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
  const session: Session = {
    id: "compact-keep-sess",
    type: "agent",
    title: "Compact keep ratio",
    createdAt: 1,
    updatedAt: 1,
    status: "idle",
    progressText: "",
    messages: transcript(),
    model: "m1",
    providerId: "p1",
    workspaceId: "ws",
    workspacePath: root,
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
    planDoc: null,
  };
  const db = openSessionDb(root);
  upsertSession(db, session);
  db.close();

  let summarizeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    summarizeCalls += 1;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { role: "assistant", content: "Compact summary of the earlier turns." },
            finish_reason: "stop",
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const store = createSessionStore(root, {
    startBackgroundServices: false,
    resolveClient: async () => ({
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "local",
      model: "m1",
      providerId: "p1",
    }),
    readSettings: async () => settings,
  });
  stores.push(store);
  return {
    store,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
    summarizeCalls: () => summarizeCalls,
  };
}

describe("/compact keep-ratio override (store level)", () => {
  it("compacts nothing under the default ratio, honors a tiny keep ratio, and drops invalid values", async () => {
    const ctx = fixture();
    try {
      // Default pass: 3 iterations (~24k tokens) fit the 40k protect budget
      // → all protected, nothing to summarize.
      const base = await ctx.store.compactSession("compact-keep-sess");
      assert.equal(base.ok, true);
      assert.equal(base.compacted, false);
      assert.equal(ctx.summarizeCalls(), 0);

      // Invalid override (> 0.9) is dropped at the trust boundary — behaves
      // exactly like the default pass.
      const invalid = await ctx.store.compactSession("compact-keep-sess", undefined, {
        protectTokenRatio: 5,
      });
      assert.equal(invalid.ok, true);
      assert.equal(invalid.compacted, false);
      assert.equal(ctx.summarizeCalls(), 0);

      // /compact 0.01 → protect budget 2k: the newest iteration alone
      // exceeds it, so every round is summarized in one pass.
      const forced = await ctx.store.compactSession("compact-keep-sess", undefined, {
        protectTokenRatio: 0.01,
      });
      assert.equal(forced.ok, true);
      assert.equal(forced.compacted, true);
      assert.equal(ctx.summarizeCalls(), 1);

      const live = ctx.store.getSession("compact-keep-sess")!;
      const marker = live.messages.find((message) =>
        message.parts.some((part) => part.type === "context_compaction"),
      );
      assert.ok(marker, "compaction marker exists");
      const part = marker!.parts.find(
        (part): part is Extract<typeof part, { type: "context_compaction" }> =>
          part.type === "context_compaction",
      )!;
      // Zero protection → coverage runs through the newest message.
      assert.equal(part.toMessageId, "a3");
    } finally {
      ctx.restore();
    }
  });
});
