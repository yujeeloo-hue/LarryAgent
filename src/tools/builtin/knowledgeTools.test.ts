import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { toolsToOpenAi } from "../../agent/toolsToOpenAi.js";
import { isAskModeToolAllowed } from "../../agent/policy/askMode.js";
import { EXPLORE_EAGER_TOOL_ALLOWLIST, SUBAGENT_TOOL_DENYLIST } from "../../agent/subagents/constants.js";
import { configureKnowledgeBase, knowledgeBase } from "../../knowledge/store.js";
import { openSessionDb } from "../../session/db/openDb.js";
import { docHashOf, resetToolDocRevisionCache, toolDocRevisionFor } from "../../toolStats/docRevision.js";
import { registerBuiltins } from "../index.js";
import { FORCED_OFFER_TOOL_NAMES } from "../offerSet.js";
import { getTool } from "../registry.js";
import type { ToolExecuteContext, ToolExecuteResult } from "../types.js";
import { deleteKnowledgeHandler } from "./deleteKnowledge.js";
import { patchKnowledgeHandler } from "./patchKnowledge.js";
import { readKnowledgeHandler } from "./readKnowledge.js";
import { searchKnowledgeHandler } from "./searchKnowledge.js";
import { toolDescribeHandler } from "./toolDescribe.js";
import { writeKnowledgeHandler } from "./writeKnowledge.js";

const context: ToolExecuteContext = { workspacePath: tmpdir(), fullPermissionsEnabled: false };

function text(result: ToolExecuteResult): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

describe("knowledge tools", () => {
  let root: string;

  before(() => {
    registerBuiltins();
    root = mkdtempSync(join(tmpdir(), "kb-tools-"));
    const builtinDir = join(root, "builtin");
    mkdirSync(join(builtinDir, "tools-management"), { recursive: true });
    writeFileSync(
      join(builtinDir, "tools-management", "_category.md"),
      '---\ntitle: MCP and Skills\ndescription: "Managing MCP and skills."\n---\n',
    );
    writeFileSync(
      join(builtinDir, "tools-management", "mcp-servers.md"),
      [
        "---",
        "title: MCP servers",
        'summary: "Create, update and delete MCP servers."',
        "keywords: [mcp, server, stdio, http]",
        "guide_for: [create_mcp_server, read_file]",
        "version: 1",
        "---",
        "",
        "## Transports\nUse stdio for local commands.",
        "",
        "## Verify\nList the advertised tools after connecting.",
      ].join("\n"),
    );
    configureKnowledgeBase({ builtinDir, userDir: join(root, "user") });
  });

  after(() => {
    configureKnowledgeBase(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("lists categories and searches by keyword", async () => {
    const listed = text(await searchKnowledgeHandler({}, context));
    assert.match(listed, /## tools-management — Managing MCP and skills\./);
    assert.match(listed, /- tools-management\/mcp-servers: MCP servers/);
    const found = await searchKnowledgeHandler({ query: "stdio" }, context);
    assert.equal(found.returnCode, 0);
    assert.match(text(found), /Found 1 doc/);
    const unknown = await searchKnowledgeHandler({ category: "nope" }, context);
    assert.equal(unknown.returnCode, 5);
  });

  it("reads whole docs, single sections and reports missing ids", async () => {
    const whole = text(await readKnowledgeHandler({ id: "tools-management/mcp-servers" }, context));
    assert.match(whole, /Source: builtin · Version: 1/);
    assert.match(whole, /Guide for: create_mcp_server, read_file/);
    const section = text(await readKnowledgeHandler({ id: "tools-management/mcp-servers", section: "verify" }, context));
    assert.match(section, /## Verify/);
    assert.doesNotMatch(section, /## Transports/);
    const missing = await readKnowledgeHandler({ id: "tools-management/nope" }, context);
    assert.equal(missing.returnCode, 3);
    assert.match(text(missing), /Closest: tools-management\/mcp-servers/);
  });

  it("requires a reason, then writes, patches and deletes user docs", async () => {
    const noReason = await writeKnowledgeHandler(
      { category: "tools-management", title: "Notes", summary: "S", keywords: ["a", "b", "c"], content: "x" },
      context,
    );
    assert.equal(noReason.returnCode, 5);

    const written = await writeKnowledgeHandler(
      {
        category: "tools-management",
        slug: "notes",
        title: "Notes",
        summary: "Personal notes.",
        keywords: ["notes", "mcp", "tips"],
        content: "## Tip\nRestart the server after edits.",
        reason: "Capture a recurring fix.",
      },
      context,
    );
    assert.equal(written.returnCode, 0);
    assert.match(text(written), /Created tools-management\/notes/);

    const patched = await patchKnowledgeHandler(
      {
        id: "tools-management/mcp-servers",
        edits: [{ old_string: "Use stdio", new_string: "Prefer stdio" }],
        reason: "Clarify.",
      },
      context,
    );
    assert.equal(patched.returnCode, 0);
    assert.match(text(patched), /Created override of built-in/);

    const reverted = await deleteKnowledgeHandler({ id: "tools-management/mcp-servers", reason: "Undo." }, context);
    assert.match(text(reverted), /back to the built-in version/);
    const denied = await deleteKnowledgeHandler({ id: "tools-management/mcp-servers", reason: "Try." }, context);
    assert.equal(denied.returnCode, 2);
    assert.equal((await deleteKnowledgeHandler({ id: "tools-management/notes", reason: "Done." }, context)).returnCode, 0);
  });

  it("appends the guide pointer to tools[] descriptions and tool_describe", async () => {
    const offered = toolsToOpenAi((name) => name === "read_file" || name === "grep");
    const readFile = offered.find((tool) => tool.function.name === "read_file")!;
    assert.match(readFile.function.description ?? "", /Guide: read_knowledge\("tools-management\/mcp-servers"\)\.$/);
    const grep = offered.find((tool) => tool.function.name === "grep")!;
    assert.equal(grep.function.description, getTool("grep")!.definition.description);

    const described = text(await toolDescribeHandler({ name: "create_mcp_server" }, context));
    assert.match(described, /Detailed guide: Guide: read_knowledge\("tools-management\/mcp-servers"\)/);
  });

  it("folds the guide body into the tool doc revision hash", () => {
    resetToolDocRevisionCache();
    const db = openSessionDb(join(root, "db"));
    try {
      toolDocRevisionFor(db, "grep");
      toolDocRevisionFor(db, "read_file");
      const rows = db.prepare("SELECT name, doc_hash FROM tool_doc_revisions").all() as Array<{ name: string; doc_hash: string }>;
      const hashes = new Map(rows.map((row) => [row.name, row.doc_hash]));
      assert.equal(hashes.get("grep"), docHashOf(getTool("grep")!.definition.description));
      assert.notEqual(hashes.get("read_file"), docHashOf(getTool("read_file")!.definition.description));
    } finally {
      db.close();
      resetToolDocRevisionCache();
    }
  });

  it("offers read/search everywhere and keeps writes away from subagents and Ask mode", () => {
    assert.ok(knowledgeBase.isConfigured());
    for (const name of ["search_knowledge", "read_knowledge"]) {
      assert.ok(FORCED_OFFER_TOOL_NAMES.has(name));
      assert.ok(isAskModeToolAllowed(name));
      assert.ok(EXPLORE_EAGER_TOOL_ALLOWLIST.has(name));
      assert.equal(getTool(name)?.definition.defaultPermissionLevel, 0);
    }
    for (const name of ["write_knowledge", "patch_knowledge", "delete_knowledge"]) {
      assert.ok(SUBAGENT_TOOL_DENYLIST.has(name));
      assert.equal(isAskModeToolAllowed(name), false);
      assert.equal(getTool(name)?.definition.defaultPermissionLevel, 0);
    }
  });
});
