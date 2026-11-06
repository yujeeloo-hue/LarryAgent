import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolExecuteContext } from "../types.js";
import { runGrep } from "./grep.js";
import { openCppSymbolDatabase } from "../../main/cppSymbols/db.js";
import { cppSymbolDatabasePath } from "../../main/cppSymbols/paths.js";
import { scanCppSymbolDatabase } from "../../main/cppSymbols/scanWorkspace.js";

let TMP = "";

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), "jb-greptest-"));
  mkdirSync(join(TMP, "src"), { recursive: true });
  writeFileSync(
    join(TMP, "src", "turnHost.ts"),
    `export class TurnHost {
  start(root: string): void {}
}
export function createTurnHost(): TurnHost {
  return new TurnHost();
}
`,
  );
  const db = openCppSymbolDatabase(cppSymbolDatabasePath(TMP));
  try {
    await scanCppSymbolDatabase({ db, root: TMP });
  } finally {
    db.close();
  }
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

function ctx(workspacePath = TMP): ToolExecuteContext {
  return {
    workspacePath,
    fullPermissionsEnabled: true,
    sessionId: "grep-test",
    toolCallId: "call_grep_1",
  };
}

describe("grep zero-hit symbol fallback", () => {
  it("appends symbol-index definitions when an identifier has no text matches", async () => {
    // Lowercase identifier: zero text hits (source spells it createTurnHost),
    // but the index lookup is case-insensitive and finds the definition.
    const result = await runGrep({ pattern: "createturnhost", context: ctx() });
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.match(result.text, /0 match\(es\)/);
    assert.match(result.text, /\(no matches\)/);
    assert.match(result.text, /Symbol index definitions for "createturnhost"/);
    assert.match(result.text, /function createTurnHost/);
  });

  it("stays untouched for regex-shaped patterns and unknown identifiers", async () => {
    const regex = await runGrep({ pattern: "createTurnHost\\(", context: ctx() });
    assert.equal(regex.returnCode, ToolReturnCode.Success);
    assert.doesNotMatch(regex.text, /Symbol index/);

    const unknown = await runGrep({ pattern: "qqqNothing", context: ctx() });
    assert.equal(unknown.returnCode, ToolReturnCode.Success);
    assert.doesNotMatch(unknown.text, /Symbol index/);
    assert.match(unknown.text, /\(no matches\)/);
  });

  it("never triggers when text matches exist", async () => {
    const result = await runGrep({ pattern: "TurnHost", context: ctx() });
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.match(result.text, /match\(es\)/);
    assert.doesNotMatch(result.text, /Symbol index/);
  });

  it("skips the hint entirely in workspaces without a symbol index", async () => {
    const empty = mkdtempSync(join(tmpdir(), "jb-greptest-empty-"));
    try {
      writeFileSync(join(empty, "a.txt"), "hello\n");
      const result = await runGrep({ pattern: "NothingHere", context: ctx(empty) });
      assert.equal(result.returnCode, ToolReturnCode.Success);
      assert.match(result.text, /\(no matches\)/);
      assert.doesNotMatch(result.text, /Symbol index/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
