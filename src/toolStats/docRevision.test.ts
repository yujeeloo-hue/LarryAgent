import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openSessionDb } from "../session/db/openDb.js";
import { listToolDocRevisions } from "../session/db/index.js";
import { upsertTool } from "../tools/registry.js";
import {
  docHashOf,
  resetToolDocRevisionCache,
  toolDocRevisionFor,
} from "./docRevision.js";
import {
  configureToolStats,
  listToolStatsInvocations,
  recordToolInvocation,
} from "./recorder.js";

function registerDocTool(name: string, description: string): void {
  upsertTool(
    {
      name,
      description,
      parameters: { type: "object", properties: {} },
      defaultPermissionLevel: 0,
    },
    async () => ({ returnCode: 0, content: [] }),
  );
}

describe("tool doc revision producer", () => {
  it("seeds the first sighting at r0 and bumps once per description edit", () => {
    resetToolDocRevisionCache();
    const root = mkdtempSync(join(tmpdir(), "jellybot-docrev-"));
    const db = openSessionDb(root);
    try {
      registerDocTool("doc_probe", "Read a file.");
      assert.equal(toolDocRevisionFor(db, "doc_probe"), 0, "first sighting is the baseline");

      assert.equal(toolDocRevisionFor(db, "doc_probe"), 0);

      registerDocTool("doc_probe", "Read a file and summarize it.");
      assert.equal(toolDocRevisionFor(db, "doc_probe"), 1, "edited description bumps");

      registerDocTool("doc_probe", "Read a file and summarize it.");
      assert.equal(toolDocRevisionFor(db, "doc_probe"), 1, "unchanged text holds the revision");

      registerDocTool("doc_probe", "Read a file.");
      assert.equal(toolDocRevisionFor(db, "doc_probe"), 2, "reverting the text is still a new revision");

      const stored = listToolDocRevisions(db).find((row) => row.name === "doc_probe");
      assert.equal(stored?.revision, 2);
      assert.equal(stored?.docHash, docHashOf("Read a file."));
    } finally {
      db.close();
      resetToolDocRevisionCache();
    }
  });

  it("keeps revisions per tool and reads the stored one after a restart", () => {
    resetToolDocRevisionCache();
    const root = mkdtempSync(join(tmpdir(), "jellybot-docrev-"));
    const first = openSessionDb(root);
    try {
      registerDocTool("doc_alpha", "Alpha v1");
      registerDocTool("doc_beta", "Beta v1");
      assert.equal(toolDocRevisionFor(first, "doc_alpha"), 0);
      assert.equal(toolDocRevisionFor(first, "doc_beta"), 0);
      registerDocTool("doc_alpha", "Alpha v2");
      assert.equal(toolDocRevisionFor(first, "doc_alpha"), 1);
      assert.equal(toolDocRevisionFor(first, "doc_beta"), 0, "other tools are untouched");
    } finally {
      first.close();
    }
    resetToolDocRevisionCache();
    const second = openSessionDb(root);
    try {
      assert.equal(toolDocRevisionFor(second, "doc_alpha"), 1);
      assert.equal(toolDocRevisionFor(second, "doc_beta"), 0);
      registerDocTool("doc_beta", "Beta v2");
      assert.equal(toolDocRevisionFor(second, "doc_beta"), 1);
    } finally {
      second.close();
      resetToolDocRevisionCache();
    }
  });

  it("never invents a revision for an unregistered tool", () => {
    resetToolDocRevisionCache();
    const root = mkdtempSync(join(tmpdir(), "jellybot-docrev-"));
    const db = openSessionDb(root);
    try {
      assert.equal(toolDocRevisionFor(db, "never_registered"), 0);
      assert.deepEqual(listToolDocRevisions(db), []);
      assert.equal(docHashOf("x").length, 32);
    } finally {
      db.close();
      resetToolDocRevisionCache();
    }
  });

  it("stamps the revision on recorded invocations without any caller plumbing", () => {
    resetToolDocRevisionCache();
    const root = mkdtempSync(join(tmpdir(), "jellybot-docrev-"));
    const db = openSessionDb(root);
    const record = (toolCallId: string): void => {
      recordToolInvocation({
        sessionId: "s-1",
        toolCallId,
        name: "doc_stamp",
        isMcp: false,
        status: "success",
        reason: "ok",
        startedAt: Date.now(),
        durationMs: 3,
      });
    };
    try {
      configureToolStats({ db, enabled: true });
      registerDocTool("doc_stamp", "Stamp v1");
      record("call-1");
      registerDocTool("doc_stamp", "Stamp v2 — now mentions the receipt");
      record("call-2");

      const byCall = new Map(
        listToolStatsInvocations({ name: "doc_stamp", limit: 10 })
          .map((row) => [row.toolCallId, row.docRevision]),
      );
      assert.deepEqual([...byCall.entries()].sort(), [["call-1", 0], ["call-2", 1]]);
    } finally {
      configureToolStats({ db, enabled: false });
      db.close();
      resetToolDocRevisionCache();
    }
  });
});
