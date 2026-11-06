import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { JsonObject, ToolExecuteContext } from "../types.js";
import { batchSearchHandler } from "./batchSearch.js";
import { openCppSymbolDatabase } from "../../main/cppSymbols/db.js";
import { cppSymbolDatabasePath } from "../../main/cppSymbols/paths.js";
import { scanCppSymbolDatabase } from "../../main/cppSymbols/scanWorkspace.js";

let TMP = "";

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), "jb-batchsearch-"));
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
  writeFileSync(join(TMP, "notes.txt"), "createTurnHost is mentioned here\n");
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

function ctx(): ToolExecuteContext {
  return {
    workspacePath: TMP,
    fullPermissionsEnabled: true,
    sessionId: "batchsearch-test",
    toolCallId: "call_batchsearch_1",
  };
}

async function text(args: JsonObject): Promise<{ text: string; code: number }> {
  const result = await batchSearchHandler(args, ctx());
  const body = result.content
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n");
  return { text: body, code: result.returnCode };
}

describe("batch_search", () => {
  it("mixes a content grep with a symbol-index lookup in one call", async () => {
    const { text: out, code } = await text({
      queries: [
        { pattern: "mentioned here" },
        { symbols: "createTurnHost" },
      ],
    });
    assert.equal(code, ToolReturnCode.Success);
    assert.match(out, /===== mentioned here =====/);
    assert.match(out, /notes\.txt:\d+:/);
    assert.match(out, /===== symbols:"createTurnHost" =====/);
    assert.match(out, /function createTurnHost: TurnHost/);
  });

  it("passes kind and path filters through to the symbol query", async () => {
    const { text: out, code } = await text({
      queries: [{ symbols: "turnhost", kind: "function" }],
    });
    assert.equal(code, ToolReturnCode.Success);
    assert.match(out, /===== symbols:"turnhost" kind=function =====/);
    assert.match(out, /function createTurnHost/);
    assert.doesNotMatch(out, /class TurnHost/);
  });

  it("rejects queries with neither pattern nor symbols", async () => {
    const { text: out, code } = await text({ queries: [{ path: TMP }] });
    assert.equal(code, ToolReturnCode.GenericFailure);
    assert.match(out, /===== invalid query =====/);
    assert.match(out, /pattern or symbols \(string\) required/);
  });

  it("rejects queries with both pattern and symbols", async () => {
    const { text: out, code } = await text({
      queries: [{ pattern: "x", symbols: "TurnHost" }],
    });
    assert.equal(code, ToolReturnCode.GenericFailure);
    assert.match(out, /provide only one of pattern or symbols/);
  });

  it("keeps plain grep queries working (legacy shape)", async () => {
    const { text: out, code } = await text({
      queries: [{ pattern: "TurnHost", path: join(TMP, "src") }],
    });
    assert.equal(code, ToolReturnCode.Success);
    assert.match(out, /===== TurnHost @ .*src =====/);
    assert.match(out, /turnHost\.ts:\d+:/);
  });
});
