import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { toolIconCatalog } from "../../../../../shared/icons/toolIconCatalog.js";
import {
  fileBasenameFromPath,
  isPlanDocTool,
  unwrapToolCallBridge,
  isRichToolCard,
  planDocPathHintFromTitle,
  readFileCardHint,
  readRangeFromArgs,
  toolCardHint,
  writeToolFilePlan,
  writeToolFilePaths,
} from "./toolInvocationHelpers.js";

describe("writeToolFilePaths", () => {
  it("reads the path arg (write_file / patch replace mode)", () => {
    assert.deepEqual(
      writeToolFilePaths({ path: "/w/src/a.ts", content: "x" }),
      ["/w/src/a.ts"],
    );
    assert.deepEqual(
      writeToolFilePaths({
        path: "/w/src/a.ts",
        old_string: "a",
        new_string: "b",
      }),
      ["/w/src/a.ts"],
    );
  });

  it("collects every V4A Update/Add header (multi-file patch)", () => {
    const paths = writeToolFilePaths({
      mode: "patch",
      patch: [
        "*** Begin Patch",
        "*** Update File: /w/src/a.ts",
        "@@",
        "*** Add File: /w/src/new.ts",
        "+x",
        "*** Update File: /w/src/a.ts",
        "*** Delete File: /w/src/gone.ts",
        "*** Move File: /w/src/old.ts -> /w/src/moved.ts",
        "*** End Patch",
      ].join("\n"),
    });
    assert.deepEqual(paths, ["/w/src/a.ts", "/w/src/new.ts"]);
  });

  it("dedupes when the path arg repeats a patch header", () => {
    assert.deepEqual(
      writeToolFilePaths({
        path: "/w/a.ts",
        patch: "*** Begin Patch\n*** Update File: /w/a.ts\n@@\n*** End Patch",
      }),
      ["/w/a.ts"],
    );
  });

  it("returns empty for non-write shapes", () => {
    assert.deepEqual(writeToolFilePaths(null), []);
    assert.deepEqual(writeToolFilePaths("read_file"), []);
    assert.deepEqual(writeToolFilePaths({}), []);
    assert.deepEqual(writeToolFilePaths({ patch: 42 }), []);
  });
});

describe("isRichToolCard", () => {
  it("keeps write / edit / plan doc / ask expandable", () => {
    for (const name of [
      "write_file",
      "patch",
      "append_file",
      "edit_file",
      "write_plan_doc",
      "ask_user",
      "request_full_permissions",
      "coco_job_input",
      "read_coco_context",
      "submit_coco_result",
    ]) {
      assert.equal(isRichToolCard(name), true, name);
    }
  });

  it("marks read / shell / grep / mcp as compact", () => {
    for (const name of [
      "read_file",
      "run_shell",
      "grep",
      "list_dir",
      "mcp__tavily__tavily_search",
      "read_skill",
    ]) {
      assert.equal(isRichToolCard(name), false, name);
    }
  });
});

describe("toolDisplay META coverage", () => {
  it("gives every BuiltinToolName a renderer display entry", () => {
    const typesSrc = readFileSync(
      new URL("../../../../../tools/types.ts", import.meta.url),
      "utf8",
    );
    const block = typesSrc.slice(
      typesSrc.indexOf("BuiltinToolName"),
      typesSrc.indexOf("export type ToolName"),
    );
    const builtin = [...block.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    assert.ok(builtin.length >= 40, `parsed builtin names: ${builtin.length}`);

    const metaKeys = new Set(Object.keys(toolIconCatalog));
    const missing = builtin.filter((name) => !metaKeys.has(name));
    assert.deepEqual(missing, []);
  });
});

describe("fileBasenameFromPath", () => {
  it("strips parent directories", () => {
    assert.equal(fileBasenameFromPath("/a/b/config.ts"), "config.ts");
    assert.equal(fileBasenameFromPath("config.ts"), "config.ts");
  });
});

describe("write_plan_doc card helpers", () => {
  it("isPlanDocTool matches only write_plan_doc", () => {
    assert.equal(isPlanDocTool("write_plan_doc"), true);
    assert.equal(isPlanDocTool("write_file"), false);
  });

  it("slugs titles into a docs/plans .md hint (mirrors planDoc.ts)", () => {
    assert.equal(
      planDocPathHintFromTitle("FSM Node SelfLoop"),
      "docs/plans/fsm-node-selfloop.md",
    );
    assert.equal(planDocPathHintFromTitle("  中文标题  "), "docs/plans/plan.md");
    assert.equal(planDocPathHintFromTitle(undefined), "docs/plans/plan.md");
  });

  it("toolCardHint shows the plan title", () => {
    assert.equal(
      toolCardHint({
        name: "write_plan_doc",
        arguments: { title: "add ask mode", content: "# x", summary: "s" },
      }),
      "add ask mode",
    );
  });
});

describe("readFileCardHint", () => {
  it("formats ranged reads with basename and line span", () => {
    assert.equal(
      readFileCardHint(
        { path: "/Users/me/proj/src/foo.ts" },
        "Lines 10-19 of 200\n10|x",
      ),
      "foo.ts · 10–19 · 10 lines",
    );
  });

  it("counts whole-file lines without repeating the tool name", () => {
    assert.equal(
      readFileCardHint({ path: "/tmp/a.md" }, "one\ntwo\nthree"),
      "a.md · 3 lines",
    );
  });
});

describe("toolCardHint", () => {
  it("shows command only for run_shell", () => {
    assert.equal(
      toolCardHint({
        name: "run_shell",
        arguments: { command: "npm test" },
      }),
      "npm test",
    );
  });

  it("shows pattern for grep without the tool name", () => {
    assert.equal(
      toolCardHint({
        name: "grep",
        arguments: { pattern: "isRichToolCard", path: "/a/b/helpers.ts" },
      }),
      '"isRichToolCard" in helpers.ts',
    );
  });

  it("skips skill / search_tools (title already has the param)", () => {
    assert.equal(
      toolCardHint({ name: "read_skill", arguments: { name: "foo" } }),
      undefined,
    );
    assert.equal(
      toolCardHint({ name: "search_tools", arguments: { query: "tavily" } }),
      undefined,
    );
    assert.equal(
      toolCardHint({ name: "search_skills", arguments: { query: "pdf" } }),
      undefined,
    );
  });

  it("shows no patch hint while the header path is still streaming", () => {
    // "/Users/you" is a fragment of /Users/youyee/… — unknown file, no hint
    // (previously surfaced as a sticky basename "you" on the card title).
    assert.equal(
      toolCardHint({
        name: "patch",
        arguments: {
          patch: "*** Begin Patch\n*** Update File: /Users/you",
        },
      }),
      undefined,
    );
  });

  it("shows the patch basename once the header line is complete", () => {
    assert.equal(
      toolCardHint({
        name: "patch",
        arguments: {
          patch:
            "*** Begin Patch\n*** Update File: /Users/youyee/dev/src/foo.ts\n@@ -1 +1 @@\n-x\n+y\n*** End Patch",
        },
      }),
      "foo.ts",
    );
  });
});

describe("unwrapToolCallBridge", () => {
  it("passes direct (non-bridge) invocations through", () => {
    const args = { command: "echo hi" };
    assert.deepEqual(unwrapToolCallBridge("run_shell", args), {
      name: "run_shell",
      arguments: args,
    });
  });

  it("unwraps a deferred bridge to the inner tool", () => {
    const innerArgs = { src: "/a", dest_host: "h", dest_path: "/x" };
    const wrapped = { name: "upload_files", arguments: innerArgs };
    assert.deepEqual(unwrapToolCallBridge("tool_call", wrapped), {
      name: "upload_files",
      arguments: innerArgs,
    });
  });

  it("leaves malformed bridge args untouched", () => {
    assert.deepEqual(unwrapToolCallBridge("tool_call", null), {
      name: "tool_call",
      arguments: null,
    });
    assert.deepEqual(unwrapToolCallBridge("tool_call", { name: "x" }), {
      name: "tool_call",
      arguments: { name: "x" },
    });
    assert.deepEqual(unwrapToolCallBridge("tool_call", "nope"), {
      name: "tool_call",
      arguments: "nope",
    });
    assert.deepEqual(unwrapToolCallBridge("tool_call", { name: "", arguments: {} }), {
      name: "tool_call",
      arguments: { name: "", arguments: {} },
    });
  });
});

describe("writeToolFilePlan", () => {
  it("opens replace-mode writes without flash ranges", () => {
    assert.deepEqual(writeToolFilePlan({ path: "/tmp/a.ts" }), [
      { path: "/tmp/a.ts", ranges: [] },
    ]);
    assert.deepEqual(writeToolFilePlan(null), []);
    assert.deepEqual(writeToolFilePlan({}), []);
  });

  it("maps V4A patch files to their changed-line ranges", () => {
    const plan = writeToolFilePlan({
      patch:
        "*** Begin Patch\n" +
        "*** Update File: src/a.ts\n" +
        "@@ -2,3 +2,3 @@\n" +
        " keep\n" +
        "-old\n" +
        "+new\n" +
        "*** Update File: src/b.ts\n" +
        "@@ -8 +8 @@\n" +
        "+late\n" +
        "*** End Patch",
    });
    assert.deepEqual(
      plan.map((f) => f.path),
      ["src/a.ts", "src/b.ts"],
    );
    assert.deepEqual(plan[0]!.ranges, [
      { start: 3, end: 3, kind: "add" },
      { start: 3, end: 3, kind: "del" },
    ]);
    assert.deepEqual(plan[1]!.ranges, [{ start: 8, end: 8, kind: "add" }]);
  });

  it("falls back to the path arg for legacy GNU bodies", () => {
    assert.deepEqual(
      writeToolFilePlan({ path: "old.txt", patch_text: "--- a/x\n+++ b/x\n" }),
      [{ path: "old.txt", ranges: [] }],
    );
  });
});

describe("readRangeFromArgs", () => {
  it("derives the exact span from offset and limit", () => {
    assert.deepEqual(
      readRangeFromArgs({ path: "/a.ts", offset: 10, limit: 40 }),
      { start: 10, end: 49 },
    );
  });

  it("offset-only reads flash through EOF; bare reads flash the file", () => {
    assert.deepEqual(readRangeFromArgs({ path: "/a.ts", offset: 7 }), {
      start: 7,
      end: null,
    });
    assert.deepEqual(readRangeFromArgs({ path: "/a.ts" }), {
      start: 1,
      end: null,
    });
  });

  it("ignores junk values", () => {
    assert.deepEqual(
      readRangeFromArgs({ path: "/a.ts", offset: "x", limit: -3 }),
      { start: 1, end: null },
    );
    assert.deepEqual(readRangeFromArgs("nope"), { start: 1, end: null });
  });
});
