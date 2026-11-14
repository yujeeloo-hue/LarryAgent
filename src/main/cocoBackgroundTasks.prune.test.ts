import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./sessionRuntime.js";
import { CocoRepository } from "../coco/repository.js";
import { BACKGROUND_SESSION_RETENTION_MS, pruneFinishedBackgroundSessions } from "./cocoBackgroundTasks.js";
import { openSessionDb, upsertSession } from "../session/db/index.js";
import type { Session, SessionSource } from "../session/types.js";
import { configureCredentialsRoot, configureLegacyKeyBridgeForTests } from "../llm/credentials.js";
import { configureUserMemoryRoot } from "../memory/store.js";

test("finished background sessions are deleted after the retention window; live and pending ones stay", async () => {
  const root = mkdtempSync(join(tmpdir(), "coco-bg-prune-")), now = Date.now(), old = now - BACKGROUND_SESSION_RETENTION_MS - 1;
  configureCredentialsRoot(root); configureLegacyKeyBridgeForTests(null); configureUserMemoryRoot(root);
  writeFileSync(join(root, "settings.json"), JSON.stringify({ providers: [{ id: "fixture", name: "Fixture", baseUrl: "http://127.0.0.1:9/v1", modelId: "fixture" }], activeProviderId: "fixture", userMemoryAutoExtract: false, projectMemoryAutoExtract: false }));
  const initial = createSessionStore(root, { startBackgroundServices: false }), workspace = await initial.createWorkspace({ name: "Prune", path: root }); initial.memorySync.stop(); initial.database.close();
  const session = (id: string, source: SessionSource): Session => ({ id, type: "agent", source, title: id, workspaceId: workspace.id, workspacePath: root, providerId: "fixture", model: "fixture", createdAt: old, updatedAt: old, status: "idle", progressText: "", pinned: false, archived: false, archivedAt: null, contextUsage: { usedTokens: 0 }, plan: null, messages: [{ id: `${id}-m`, role: "user", createdAt: old, parts: [{ type: "text", text: "detail" }] }] });
  const db = openSessionDb(root);
  for (const id of ["stale", "recent", "pending", "retention"]) upsertSession(db, session(id, "coco_internal"));
  upsertSession(db, session("ordinary", "app"));
  db.close();
  const store = createSessionStore(root, { startBackgroundServices: false }), repository = new CocoRepository(store.database);
  try {
    const put = (id: string, sessionId: string, extra: Record<string, unknown>) => { repository.put("backgroundSession", { id, sessionId, purpose: "plan", at: old, status: "completed", ...extra }); repository.put("backgroundInput", { id, input: { big: "x" }, at: old }); };
    put("stale-job:0", "stale", { operationId: "stale-job", endedAt: old });
    put("recent-job:0", "recent", { operationId: "recent-job", endedAt: now - 1000 });
    put("pending-job:0", "pending", { operationId: "pending-job", endedAt: old });
    repository.put("job", { id: "pending-job", kind: "plan", status: "queued", at: old, priority: 0 });
    put("retention-x:0", "retention", { purpose: "retention", endedAt: old });
    put("ordinary-op:0", "ordinary", { endedAt: old });
    repository.put("backgroundInput", { id: "orphan:0", input: {}, at: old });

    pruneFinishedBackgroundSessions(repository, store, now);

    assert.equal(repository.get("backgroundSession", "stale-job:0"), undefined);
    assert.equal(repository.get("backgroundInput", "stale-job:0"), undefined);
    assert.equal(store.getSessionSummary("stale"), null);
    assert.equal(store.database.prepare("SELECT id FROM messages WHERE id='stale-m'").get(), undefined);
    for (const id of ["recent-job:0", "pending-job:0", "retention-x:0"]) assert.ok(repository.get("backgroundSession", id), `${id} must stay`);
    for (const id of ["recent", "pending", "retention"]) assert.ok(store.getSessionSummary(id), `${id} session must stay`);
    assert.ok(store.getSessionSummary("ordinary"), "non-background sessions are never deleted");
    assert.ok(repository.get("backgroundSession", "ordinary-op:0"), "record is kept when its session cannot be deleted");
    assert.equal(repository.get("backgroundInput", "orphan:0"), undefined);
  } finally {
    store.memorySync.stop(); store.database.close(); rmSync(root, { recursive: true, force: true });
  }
});
