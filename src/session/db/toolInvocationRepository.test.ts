import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SHELL_TOOL_NAME } from "../../tools/shellToolName.js";
import { openSessionDb } from "./openDb.js";
import {
  canonicalToolName,
  clearToolInvocations,
  insertToolInvocation,
  listToolInvocations,
  summarizeToolInvocations,
} from "./toolInvocationRepository.js";
import type { ToolInvocationRecord } from "./toolInvocationRepository.js";

function makeRecord(
  id: string,
  name: string,
  status: ToolInvocationRecord["status"],
  overrides: Partial<ToolInvocationRecord> = {},
): ToolInvocationRecord {
  const now = Date.now();
  return {
    id,
    sessionId: "s-1",
    toolCallId: `call-${id}`,
    name,
    isMcp: false,
    status,
    reason: status === "success" ? "ok" : "tool_error",
    startedAt: now,
    durationMs: 10,
    docRevision: 0,
    createdAt: now,
    ...overrides,
  };
}

describe("toolInvocationRepository", () => {
  it("summarizes legacy names under their canonical tool", () => {
    const root = mkdtempSync(join(tmpdir(), "jellybot-toolstats-"));
    const db = openSessionDb(root);
    try {
      insertToolInvocation(db, makeRecord("1", "edit_file", "success"));
      insertToolInvocation(db, makeRecord("2", "edit_file", "tool_error"));
      insertToolInvocation(db, makeRecord("3", "append_file", "success"));
      insertToolInvocation(db, makeRecord("4", "patch", "success"));
      insertToolInvocation(db, makeRecord("5", "bash", "success"));
      insertToolInvocation(db, makeRecord("6", "run_shell", "success"));

      const summary = summarizeToolInvocations(db);
      const byName = new Map(summary.map((row) => [row.name, row]));
      const patch = byName.get("patch");
      assert.ok(patch, "patch row exists");
      assert.equal(patch.calls, 4);
      assert.equal(patch.success, 3);
      assert.equal(patch.failure, 1);
      const shell = byName.get(SHELL_TOOL_NAME);
      assert.ok(shell, `${SHELL_TOOL_NAME} row exists`);
      assert.equal(shell.calls, 2);
      assert.equal(shell.success, 2);
      assert.equal(
        byName.has("edit_file"),
        false,
        "legacy name is not a separate row",
      );
      assert.equal(byName.has("append_file"), false);
      assert.equal(byName.has("bash"), false);
    } finally {
      db.close();
    }
  });

  it("lists invocations for a canonical name across legacy aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "jellybot-toolstats-"));
    const db = openSessionDb(root);
    try {
      insertToolInvocation(db, makeRecord("1", "edit_file", "success"));
      insertToolInvocation(db, makeRecord("2", "append_file", "success"));
      insertToolInvocation(db, makeRecord("3", "patch", "success"));
      insertToolInvocation(db, makeRecord("4", "write_file", "success"));

      const rows = listToolInvocations(db, { name: "patch", limit: 50 });
      assert.equal(rows.length, 3);
      const storedNames = rows.map((row) => row.name).sort();
      assert.deepEqual(storedNames, [
        "append_file",
        "edit_file",
        "patch",
      ]);

      const exact = listToolInvocations(db, { name: "write_file", limit: 50 });
      assert.equal(exact.length, 1);
      assert.equal(exact[0]?.name, "write_file");
    } finally {
      db.close();
    }
  });

  it("clears every recorded invocation and reports the removed count", () => {
    const root = mkdtempSync(join(tmpdir(), "jellybot-toolstats-"));
    const db = openSessionDb(root);
    try {
      insertToolInvocation(db, makeRecord("1", "run_shell", "success"));
      insertToolInvocation(db, makeRecord("2", "grep", "success"));
      insertToolInvocation(db, makeRecord("3", "grep", "tool_error"));

      const removed = clearToolInvocations(db);
      assert.equal(removed, 3);
      assert.deepEqual(summarizeToolInvocations(db), []);
      assert.deepEqual(listToolInvocations(db, {}), []);
      assert.equal(clearToolInvocations(db), 0);
    } finally {
      db.close();
    }
  });

  it("maps legacy names via canonicalToolName", () => {
    assert.equal(canonicalToolName("edit_file"), "patch");
    assert.equal(canonicalToolName("append_file"), "patch");
    assert.equal(canonicalToolName("bash"), SHELL_TOOL_NAME);
    assert.equal(canonicalToolName("patch"), "patch");
    assert.equal(canonicalToolName("mcp__tavily__tavily_search"), "mcp__tavily__tavily_search");
  });

  it("stores and reads back the tool doc revision (default 0)", () => {
    const root = mkdtempSync(join(tmpdir(), "jellybot-toolstats-"));
    const db = openSessionDb(root);
    try {
      insertToolInvocation(db, makeRecord("1", "read_file", "success"));
      insertToolInvocation(
        db,
        makeRecord("2", "read_file", "tool_error", { docRevision: 3 }),
      );

      const byId = new Map(
        listToolInvocations(db, { limit: 50 }).map((row) => [row.id, row]),
      );
      assert.equal(byId.get("1")?.docRevision, 0, "absent → default 0");
      assert.equal(byId.get("2")?.docRevision, 3);

      const direct = db
        .prepare(`SELECT doc_revision FROM tool_invocations WHERE id = '1'`)
        .get() as { doc_revision: number };
      assert.equal(direct.doc_revision, 0);
    } finally {
      db.close();
    }
  });

  it("filters summary and listings to one conversation incl. subagents", () => {
    const root = mkdtempSync(join(tmpdir(), "jellybot-toolstats-"));
    const db = openSessionDb(root);
    try {
      insertToolInvocation(db, makeRecord("1", "run_shell", "success"));
      insertToolInvocation(
        db,
        makeRecord("2", "run_shell", "success", { sessionId: "s-2" }),
      );
      insertToolInvocation(
        db,
        makeRecord("3", "grep", "tool_error", {
          sessionId: "sub-1",
          parentSessionId: "s-2",
        }),
      );
      insertToolInvocation(
        db,
        makeRecord("4", "read_file", "success", {
          sessionId: "sub-1",
          parentSessionId: "s-9",
        }),
      );
      insertToolInvocation(
        db,
        makeRecord("5", "grep", "success", { sessionId: "s-9" }),
      );

      const summary = summarizeToolInvocations(db, { sessionId: "s-2" });
      const byName = new Map(summary.map((row) => [row.name, row]));
      assert.equal(byName.get(SHELL_TOOL_NAME)?.calls, 1);
      assert.equal(byName.get("grep")?.calls, 1);
      assert.equal(byName.get("read_file"), undefined);

      const rows = listToolInvocations(db, {
        sessionId: "s-2",
        limit: 50,
      });
      assert.deepEqual(
        rows.map((row) => row.id).sort(),
        ["2", "3"],
        "own calls + subagent calls with parent_session_id match",
      );

      const global = listToolInvocations(db, { limit: 50 });
      assert.equal(global.length, 5);
    } finally {
      db.close();
    }
  });
});
