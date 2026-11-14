/**
 * Per-CoCo Chat compaction overrides (Settings → CoCo): a commander
 * execution access carrying the compaction getter replaces the global Agent
 * knobs for its own turns and manual compacts; other lanes and ordinary
 * sessions keep the global values. An explicit `/compact <keep>` value still
 * wins over the CoCo default.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { after, describe, it } from "node:test";
import type { RunAgentTurnInput } from "../agent/types.js";
import { configureFsmGraphsRoot } from "../agent/fsm/graphLibrary/manager.js";
import { registerCocoExecution } from "../coco/executionAccess.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";
import { openSessionDb, upsertSession } from "../session/db/index.js";
import type { Message, Session } from "../session/types.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import type { WorkspaceSettings } from "../settings/types.js";
import { createSessionStore, type SessionStore } from "./sessionRuntime.js";

const stores: SessionStore[] = [];
after(() => { for (const store of stores) store.memorySync.stop(); });

/** Common one-token words repeated → ~8k o200k tokens per assistant message. */
const bigBody = (tag: string): string => `the quick brown fox jumps over the lazy dog number ${tag} `.repeat(900);

function transcript(): Message[] {
  const messages: Message[] = [];
  for (let i = 1; i <= 3; i += 1) {
    messages.push({ id: `u${i}`, role: "user", parts: [{ type: "text", text: `Request number ${i}` }], createdAt: i * 10 });
    messages.push({ id: `a${i}`, role: "assistant", parts: [{ type: "text", text: bigBody(String(i)) }], createdAt: i * 10 + 1 });
  }
  return messages;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jellybot-coco-compaction-"));
  configureUserMemoryRoot(root);
  configureCredentialsRoot(root);
  configureLegacyKeyBridgeForTests(null);
  configureFsmGraphsRoot(join(root, "graphs"));
  configurePromptDefaults(join(process.cwd(), "resources", "prompts"));
  // 200k limit, no ratio overrides → global defaults 0.55 trigger / 0.2 keep
  // (protect budget 40k keeps all three ~8k iterations raw).
  const settings: WorkspaceSettings = {
    providers: [{ id: "p1", name: "One", baseUrl: "http://127.0.0.1:9/v1", modelId: "m1" }],
    activeProviderId: "p1",
    composerRunMode: "agent",
    contextLimitTokens: 200_000,
    userMemoryAutoExtract: false,
    projectMemoryAutoExtract: false,
  };
  writeFileSync(join(root, "settings.json"), JSON.stringify(settings));
  const base: Omit<Session, "id" | "messages"> = {
    type: "agent", title: "CoCo chat compaction", createdAt: 1, updatedAt: 1, status: "idle", progressText: "",
    model: "m1", providerId: "p1", workspaceId: "ws", workspacePath: root, pinned: false, archived: false,
    archivedAt: null, contextUsage: { usedTokens: 0 }, plan: null, planDoc: null,
  };
  const db = openSessionDb(root);
  // Message ids are unique across the whole DB — prefix per session.
  const rows: Session[] = [];
  for (const id of ["coco-chat", "coco-chat-2", "coco-chat-3"]) rows.push({ ...base, id, source: "coco_chat", messages: transcript().map(m => ({ ...m, id: `${id}-${m.id}` })) });
  rows.push({ ...base, id: "coco-internal", source: "coco_internal", messages: transcript().map(m => ({ ...m, id: `coco-internal-${m.id}` })) });
  rows.push({ ...base, id: "ordinary", messages: transcript().map(m => ({ ...m, id: `ordinary-${m.id}` })) });
  for (const row of rows) upsertSession(db, row);
  db.close();

  let summarizeCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    summarizeCalls += 1;
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "Compact summary of the earlier turns." }, finish_reason: "stop" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const calls: RunAgentTurnInput[] = [];
  const store = createSessionStore(root, {
    startBackgroundServices: false,
    resolveClient: async () => ({ baseUrl: "http://127.0.0.1:9/v1", apiKey: "local", model: "m1", providerId: "p1" }),
    readSettings: async () => settings,
    runAgentTurn: async input => {
      calls.push(input);
      input.session.status = "idle";
      return { status: "idle", modelIterations: 0 };
    },
  });
  stores.push(store);

  const access = (overrides: { role?: "commander" | "background"; compaction?: () => { compactTriggerRatio?: number | undefined; iterationProtectTokenRatio?: number | undefined }; summarize?: import("../agent/types.js").SummarizeFn }) =>
    registerCocoExecution({
      role: "commander", workspaceId: "ws", signal: new AbortController().signal, canStartTurn: () => true,
      stream: async function* () {}, summarize: async () => ({ content: "" }),
      assertTool: () => {}, assertPath: () => {}, beforeToolExecute: () => {},
      ...overrides,
    });

  return {
    root, store, calls, access,
    summarizeCalls: () => summarizeCalls,
    restore: () => { globalThis.fetch = originalFetch; },
  };
}

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200 && !predicate(); i++) await nextTick();
  assert.ok(predicate(), "condition never became true");
}

describe("per-CoCo Chat compaction overrides", () => {
  it("commander turns use the CoCo ratios; absent fields, other lanes, and ordinary turns keep the global knobs", async () => {
    const f = fixture();
    const tuned = f.access({ compaction: () => ({ compactTriggerRatio: 0.6, iterationProtectTokenRatio: 0.3 }) });
    const partial = f.access({ compaction: () => ({ iterationProtectTokenRatio: 0.05 }) });
    const background = f.access({ role: "background", compaction: () => ({ compactTriggerRatio: 0.95, iterationProtectTokenRatio: 0.9 }) });
    try {
      await f.store.startTurn({ sessionId: "coco-chat", userText: "Tuned", fullPermissions: true, source: "coco_chat", cocoExecutionId: tuned.id });
      await waitFor(() => !f.store.isTurnActive("coco-chat"));
      await f.store.startTurn({ sessionId: "coco-chat", userText: "Partial", fullPermissions: true, source: "coco_chat", cocoExecutionId: partial.id });
      await waitFor(() => !f.store.isTurnActive("coco-chat"));
      await f.store.startTurn({ sessionId: "coco-internal", userText: "Background", fullPermissions: true, source: "coco_internal", cocoExecutionId: background.id });
      await waitFor(() => !f.store.isTurnActive("coco-internal"));
      await f.store.startTurn({ sessionId: "ordinary", userText: "Ordinary", fullPermissions: true });
      await waitFor(() => !f.store.isTurnActive("ordinary"));
      assert.equal(f.calls.length, 4);

      assert.equal(f.calls.length, 4);
      assert.equal(f.calls[0]!.compactTriggerRatio, 0.6, "commander turn uses the CoCo trigger ratio");
      assert.equal(f.calls[0]!.iterationProtectTokenRatio, 0.3, "commander turn uses the CoCo keep ratio");
      assert.equal(f.calls[1]!.compactTriggerRatio, 0.55, "an absent override inherits the global trigger default");
      assert.equal(f.calls[1]!.iterationProtectTokenRatio, 0.05, "a present keep override applies on its own");
      assert.equal(f.calls[2]!.compactTriggerRatio, 0.55, "background lanes ignore the compaction getter");
      assert.equal(f.calls[2]!.iterationProtectTokenRatio, 0.2, "background lanes ignore the compaction getter");
      assert.equal(f.calls[3]!.compactTriggerRatio, 0.55, "ordinary turns are untouched");
      assert.equal(f.calls[3]!.iterationProtectTokenRatio, 0.2, "ordinary turns are untouched");
    } finally {
      for (const access of [tuned, partial, background]) access.release();
      f.restore();
    }
  });

  it("manual compact honors the CoCo keep ratio; an explicit /compact keep value still wins", async () => {
    const f = fixture();
    // An attached CoCo execution supplies its own (metered) summarize fn, so
    // count summaries through that channel, not the global fetch stub.
    let coCoSummaries = 0;
    const tuned = f.access({
      compaction: () => ({ iterationProtectTokenRatio: 0.01 }),
      summarize: async () => { coCoSummaries += 1; return { content: "Compact summary of the earlier turns." }; },
    });
    const background = f.access({ role: "background", compaction: () => ({ iterationProtectTokenRatio: 0.01 }) });
    try {
      // No execution → global keep 0.2 (40k budget) protects everything.
      const base = await f.store.compactSession("coco-chat");
      assert.equal(base.ok, true);
      assert.equal(base.compacted, false);
      assert.equal(coCoSummaries, 0);

      // Background role carries the getter but is ignored → still global.
      const ignored = await f.store.compactSession("coco-chat", background.id);
      assert.equal(ignored.compacted, false);
      assert.equal(coCoSummaries, 0);

      // Commander keep 0.01 → 2k budget: everything is summarized in one pass.
      const forced = await f.store.compactSession("coco-chat", tuned.id);
      assert.equal(forced.compacted, true);
      assert.equal(coCoSummaries, 1);

      // Explicit keep 0.5 (100k budget) beats the CoCo default 0.01 → protected again.
      const explicit = await f.store.compactSession("coco-chat-2", tuned.id, { protectTokenRatio: 0.5 });
      assert.equal(explicit.compacted, false);
      assert.equal(coCoSummaries, 1);
    } finally {
      for (const access of [tuned, background]) access.release();
      f.restore();
    }
  });
});
