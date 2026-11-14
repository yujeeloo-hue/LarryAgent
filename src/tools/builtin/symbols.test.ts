import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { JsonObject, ToolExecuteContext } from "../types.js";
import {
  configureSymbolIndexService,
  symbolsHandler,
} from "./symbols.js";
import { openCppSymbolDatabase } from "../../main/cppSymbols/db.js";
import { cppSymbolDatabasePath } from "../../main/cppSymbols/paths.js";
import { scanCppSymbolDatabase } from "../../main/cppSymbols/scanWorkspace.js";

let TMP = "";

before(async () => {
  TMP = mkdtempSync(join(tmpdir(), "jb-symbolstool-"));
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
  writeFileSync(
    join(TMP, "src", "theme.css"),
    `:root { --accent: #58a6ff; }
.toolbar { color: red; }
`,
  );
  // Build the index once so the handler has a database to read.
  const db = openCppSymbolDatabase(cppSymbolDatabasePath(TMP));
  try {
    await scanCppSymbolDatabase({ db, root: TMP });
  } finally {
    db.close();
  }
});

after(() => {
  rmSync(TMP, { recursive: true, force: true });
  configureSymbolIndexService(null);
});

function ctx(overrides?: Partial<ToolExecuteContext>): ToolExecuteContext {
  return {
    workspacePath: TMP,
    fullPermissionsEnabled: true,
    sessionId: "symbols-test",
    toolCallId: "call_symbols_1",
    ...overrides,
  };
}

async function text(args: JsonObject): Promise<{
  text: string;
  code: number;
}> {
  const result = await symbolsHandler(args, ctx());
  const body = result.content
    .filter((p) => p.type === "text")
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n");
  return { text: body, code: result.returnCode };
}

describe("symbols tool", () => {
  it("returns indexed TS definitions with kind and container", async () => {
    const { text: out, code } = await text({ query: "createTurnHost" });
    assert.equal(code, ToolReturnCode.Success);
    assert.match(out, /1 hit\(s\) \(exact match\)/);
    assert.match(out, /function createTurnHost: TurnHost/);
    assert.match(out, new RegExp(`src[/\\\\]turnHost\\.ts:\\d+:`));
  });

  it("finds class rows and CSS names by their prefixed names", async () => {
    const cls = await text({ query: "TurnHost" });
    assert.match(cls.text, /class TurnHost/);

    const cssVar = await text({ query: "--accent" });
    assert.match(cssVar.text, /variable --accent/);

    const sel = await text({ query: ".toolbar" });
    assert.match(sel.text, /type \.toolbar/);
  });

  it("filters by kind", async () => {
    const { text: out } = await text({ query: "turnhost", kind: "function" });
    assert.doesNotMatch(out, /class TurnHost/);
    assert.match(out, /function/);
  });

  it("rejects short queries and unknown kinds", async () => {
    const short = await text({ query: "x" });
    assert.equal(short.code, ToolReturnCode.InvalidArguments);

    const badKind = await text({ query: "TurnHost", kind: "method" });
    assert.equal(badKind.code, ToolReturnCode.InvalidArguments);
    assert.match(badKind.text, /unknown kind/);
  });

  it("guides toward grep and starts a background build without an index", async () => {
    const empty = mkdtempSync(join(tmpdir(), "jb-symbolstool-empty-"));
    const started: string[] = [];
    configureSymbolIndexService({
      start: (root) => started.push(root),
    });
    try {
      const result = await symbolsHandler(
        { query: "anything" },
        ctx({ workspacePath: empty }),
      );
      const body = result.content
        .filter((p) => p.type === "text")
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("\n");
      assert.equal(result.returnCode, ToolReturnCode.Success);
      assert.match(body, /no symbol index|still building/);
      assert.match(body, /grep/);
      assert.deepEqual(started, [empty]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
      configureSymbolIndexService(null);
    }
  });

  it("reports empty results without erroring", async () => {
    const { text: out, code } = await text({ query: "zzz-nothing" });
    assert.equal(code, ToolReturnCode.Success);
    assert.match(out, /no matches/);
  });
});
