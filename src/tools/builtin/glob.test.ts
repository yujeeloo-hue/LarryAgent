import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolExecuteContext } from "../types.js";
import { globHandler } from "./glob.js";

let ROOT = "";

function ctx(): ToolExecuteContext {
  return {
    workspacePath: ROOT,
    fullPermissionsEnabled: true,
    sessionId: "glob-test",
    toolCallId: "call_glob_1",
  };
}

function text(result: Awaited<ReturnType<typeof globHandler>>): string {
  const part = result.content[0];
  return part && part.type === "text" ? part.text : "";
}

before(() => {
  ROOT = mkdtempSync(join(tmpdir(), "jb-globtest-"));
  mkdirSync(join(ROOT, "src", "deep"), { recursive: true });
  mkdirSync(join(ROOT, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(ROOT, "src", "old.ts"), "");
  writeFileSync(join(ROOT, "src", "deep", "new.ts"), "");
  writeFileSync(join(ROOT, "src", "notes.md"), "");
  writeFileSync(join(ROOT, "node_modules", "dep", "index.ts"), "");
  const past = new Date(Date.now() - 60_000);
  utimesSync(join(ROOT, "src", "old.ts"), past, past);
});

after(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

describe("glob tool", () => {
  it("finds files at any depth, newest first, skipping ignored dirs", async () => {
    const result = await globHandler({ pattern: "*.ts" }, ctx());
    assert.equal(result.returnCode, ToolReturnCode.Success);
    const lines = text(result).split("\n");
    assert.match(lines[0]!, /— 2 file\(s\)/);
    assert.match(lines[1]!, /deep\/new\.ts$/);
    assert.match(lines[2]!, /old\.ts$/);
    assert.doesNotMatch(text(result), /node_modules/);
  });

  it("applies limit with a note and reports empty results", async () => {
    const limited = await globHandler({ pattern: "*.ts", limit: 1 }, ctx());
    assert.match(text(limited), /showing 1 most recent of 2/);

    const none = await globHandler({ pattern: "*.rs" }, ctx());
    assert.match(text(none), /\(no files\)/);
  });

  it("rejects a missing pattern and non-directory paths", async () => {
    const missing = await globHandler({}, ctx());
    assert.equal(missing.returnCode, ToolReturnCode.InvalidArguments);
    const notDir = await globHandler(
      { pattern: "*", path: join(ROOT, "src", "notes.md") },
      ctx(),
    );
    assert.equal(notDir.returnCode, ToolReturnCode.InvalidArguments);
  });
});
