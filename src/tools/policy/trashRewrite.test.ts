import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  TRASH_GLOB_LIMIT,
  configureTrashMover,
  executeTrashRewrite,
  resetTrashMoverForTests,
} from "./trashRewrite.js";

// Windows paths contain backslashes — escape them before splicing into a regex.
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  const part = result.content[0];
  assert.ok(part && part.type === "text" && typeof part.text === "string");
  return part.text;
}

async function makeTempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jellybot-trash-test-"));
}

describe("executeTrashRewrite", () => {
  it("moves each target via trashItem in argument order and exits 0", async () => {
    const root = await makeTempWorkspace();
    try {
      const a = join(root, "a.txt");
      const b = join(root, "b.txt");
      await writeFile(a, "a", "utf8");
      await writeFile(b, "b", "utf8");

      const calls: string[] = [];
      const result = await executeTrashRewrite(
        { type: "trash", targets: [a, b], force: false, originalCommand: `rm ${a} ${b}` },
        undefined,
        async (p) => {
          calls.push(p);
        },
      );

      assert.deepEqual(calls, [a, b]);
      assert.equal(result.returnCode, ToolReturnCode.Success);
      const out = text(result);
      assert.match(out, /^\$ rm /);
      assert.match(out, new RegExp(`moved to Trash: ${escapeRe(a)}`));
      assert.match(out, new RegExp(`moved to Trash: ${escapeRe(b)}`));
      assert.match(out, /exit 0 \(Trash rewrite\)$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports missing targets without force (rm semantics) and exits 1", async () => {
    const missing = join(tmpdir(), "definitely-not-here-9f2a.txt");
    const calls: string[] = [];
    const result = await executeTrashRewrite(
      { type: "trash", targets: [missing], force: false, originalCommand: `rm ${missing}` },
      undefined,
      async (p) => {
        calls.push(p);
      },
    );

    assert.deepEqual(calls, []);
    assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
    const out = text(result);
    assert.match(
      out,
      new RegExp(`rm: ${escapeRe(missing)}: No such file or directory`),
    );
    assert.match(out, /exit 1 \(Trash rewrite\)$/);
  });

  it("silently skips missing targets with force and still exits 0", async () => {
    const root = await makeTempWorkspace();
    try {
      const present = join(root, "kept.txt");
      await writeFile(present, "x", "utf8");
      const missing = join(root, "gone.txt");

      const calls: string[] = [];
      const result = await executeTrashRewrite(
        { type: "trash", targets: [missing, present], force: true, originalCommand: `rm -f ${missing} ${present}` },
        undefined,
        async (p) => {
          calls.push(p);
        },
      );

      assert.deepEqual(calls, [present]);
      assert.equal(result.returnCode, ToolReturnCode.Success);
      const out = text(result);
      assert.doesNotMatch(out, /No such file/);
      assert.match(out, /exit 0 \(Trash rewrite\)$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("passes per-target trashItem failures through instead of swallowing", async () => {
    const root = await makeTempWorkspace();
    try {
      const ok = join(root, "ok.txt");
      const bad = join(root, "bad-dir");
      await writeFile(ok, "ok", "utf8");
      await mkdir(bad);

      const result = await executeTrashRewrite(
        { type: "trash", targets: [ok, bad], force: false, originalCommand: `rm ${ok} ${bad}` },
        undefined,
        async (p) => {
          if (p === bad) throw new Error("EPERM: cross-volume move denied");
        },
      );

      assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
      const out = text(result);
      assert.match(out, new RegExp(`moved to Trash: ${escapeRe(ok)}`));
      assert.match(out, /rm: failed to move .*bad-dir to Trash: EPERM: cross-volume move denied/);
      assert.match(out, /exit 1 \(Trash rewrite\)$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns Cancelled when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const calls: string[] = [];
    const result = await executeTrashRewrite(
      { type: "trash", targets: ["/tmp/whatever"], force: false, originalCommand: "rm /tmp/whatever" },
      controller.signal,
      async (p) => {
        calls.push(p);
      },
    );
    assert.deepEqual(calls, []);
    assert.equal(result.returnCode, ToolReturnCode.Cancelled);
    assert.equal(text(result), "Cancelled");
  });

  it("returns Cancelled mid-run when the signal fires between targets", async () => {
    const root = await makeTempWorkspace();
    try {
      const a = join(root, "first.txt");
      const b = join(root, "second.txt");
      await writeFile(a, "a", "utf8");
      await writeFile(b, "b", "utf8");

      const controller = new AbortController();
      const callsSoFar: string[] = [];
      const result = await executeTrashRewrite(
        { type: "trash", targets: [a, b], force: false, originalCommand: `rm ${a} ${b}` },
        controller.signal,
        async (p) => {
          callsSoFar.push(p);
          if (p === a) controller.abort();
        },
      );

      assert.deepEqual(callsSoFar, [a]);
      assert.equal(result.returnCode, ToolReturnCode.Cancelled);
      assert.equal(text(result), "Cancelled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("executeTrashRewrite — glob patterns (v2)", () => {
  it("expands glob patterns and moves every match to the Trash", async () => {
    const root = await makeTempWorkspace();
    try {
      await writeFile(join(root, "a.log"), "a", "utf8");
      await writeFile(join(root, "b.log"), "b", "utf8");
      await writeFile(join(root, "keep.txt"), "k", "utf8");

      const calls: string[] = [];
      const result = await executeTrashRewrite(
        {
          type: "trash",
          targets: [join(root, "*.log")],
          force: false,
          originalCommand: `rm ${root}/*.log`,
        },
        undefined,
        async (p) => {
          calls.push(p);
        },
      );

      assert.deepEqual(calls.sort(), [join(root, "a.log"), join(root, "b.log")]);
      assert.equal(result.returnCode, ToolReturnCode.Success);
      const out = text(result);
      assert.match(out, /exit 0 \(Trash rewrite\)$/);
      assert.doesNotMatch(out, /keep\.txt/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports no matches like zsh nomatch and deletes nothing", async () => {
    const root = await makeTempWorkspace();
    try {
      const calls: string[] = [];
      const result = await executeTrashRewrite(
        {
          type: "trash",
          targets: [join(root, "*.missing")],
          force: false,
          originalCommand: `rm ${root}/*.missing`,
        },
        undefined,
        async (p) => {
          calls.push(p);
        },
      );

      assert.deepEqual(calls, []);
      assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
      const out = text(result);
      assert.match(out, new RegExp(`rm: no matches found: .*\\.missing`));
      assert.match(out, /exit 1 \(Trash rewrite\)$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails the whole command with zero deletions when expansion exceeds the limit", async () => {
    const root = await makeTempWorkspace();
    try {
      // Pattern matching >4096 real files: generate them.
      const bulk = join(root, "bulk");
      await mkdir(bulk);
      const over = TRASH_GLOB_LIMIT + 1;
      await Promise.all(
        Array.from({ length: over }, (_, i) =>
          writeFile(join(bulk, `f${i}.tmp`), "x", "utf8"),
        ),
      );
      const present = join(root, "present.txt");
      await writeFile(present, "p", "utf8");

      const calls: string[] = [];
      const result = await executeTrashRewrite(
        {
          type: "trash",
          targets: [join(bulk, "*.tmp"), present],
          force: false,
          originalCommand: `rm ${bulk}/*.tmp ${present}`,
        },
        undefined,
        async (p) => {
          calls.push(p);
        },
      );

      // Whole-command failure: nothing moved, including the literal target.
      assert.deepEqual(calls, []);
      assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
      const out = text(result);
      assert.match(out, /glob expansion exceeds 4096 matches — nothing was deleted/);
      assert.match(out, /Narrow the pattern or delete in smaller batches/);
      assert.match(out, /exit 1 \(Trash rewrite\)$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes through the host-injected mover (configureTrashMover)", async () => {
    const root = await makeTempWorkspace();
    try {
      const target = join(root, "injected.txt");
      await writeFile(target, "x", "utf8");

      const seen: string[] = [];
      configureTrashMover(async (p) => {
        seen.push(p);
      });
      try {
        const result = await executeTrashRewrite({
          type: "trash",
          targets: [target],
          force: false,
          originalCommand: `rm ${target}`,
        });
        assert.equal(result.returnCode, ToolReturnCode.Success);
        assert.deepEqual(seen, [target]);
        assert.match(text(result), /moved to Trash: /);
      } finally {
        resetTrashMoverForTests();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Trash exclusions", () => {
  it("validates every expanded glob before moving any target", async () => {
    const root = await makeTempWorkspace(), moved: string[] = [];
    try {
      await writeFile(join(root,"allowed.txt"),"allowed"); await writeFile(join(root,"excluded.txt"),"excluded");
      await assert.rejects(executeTrashRewrite({type:"trash",targets:[join(root,"*.txt")],force:false,originalCommand:"rm *.txt"},undefined,async path=>{moved.push(path);},path=>{if(path.endsWith("excluded.txt"))throw new Error("Excluded project");}),/Excluded project/);
      assert.deepEqual(moved,[]);
    } finally {await rm(root,{recursive:true,force:true});}
  });
});
