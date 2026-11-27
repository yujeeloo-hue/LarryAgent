import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolReturnCode } from "../session/returnCodes.js";
import { textResult } from "../tools/pathUtil.js";
import type { JsonObject, ToolExecuteResult } from "../tools/types.js";
import {
  runUnrealBlueprintLookup,
  runUnrealBlueprintOpen,
  runUnrealBlueprintSelect,
  runUnrealEditorFindReferences,
  runUnrealEditorOpen,
  type UnrealEditorCaller,
  type UnrealEditorClientDeps,
} from "./editorClient.js";
import { projectFileKey, type UnrealEditorBinding } from "./editorProtocol.js";

const PROJECT = "E:/NF/Game.uproject";

function binding(
  ready: boolean,
  capabilities: string[] = ["references", "open"],
): UnrealEditorBinding {
  return {
    serverId: "editor",
    projectFile: PROJECT,
    projectKey: projectFileKey(PROJECT),
    engineVersion: "5.7.1",
    ready,
    capabilities,
    connectedAt: 1,
    source: "probe",
    lastSeenAt: 1,
  };
}

function deps(
  bindings: readonly UnrealEditorBinding[],
  call: UnrealEditorCaller,
  projectFile: string | null = PROJECT,
): UnrealEditorClientDeps {
  return {
    locateProjectFile: () => projectFile,
    bindings,
    call,
  };
}

test("find references reports when no editor is bound", async () => {
  let called = false;
  const result = await runUnrealEditorFindReferences(
    deps([], () => {
      called = true;
      return Promise.resolve(textResult("no", ToolReturnCode.Success));
    }, null),
    "E:/NF",
    { kind: "class", className: "AMyCharacter" },
  );
  assert.equal(called, false);
  assert.equal(result.returnCode, ToolReturnCode.NotFound);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /not_connected/);
});

test("find references does not query an editor that is not ready", async () => {
  let called = false;
  const result = await runUnrealEditorFindReferences(
    deps([binding(false)], () => {
      called = true;
      return Promise.resolve(textResult("no", ToolReturnCode.Success));
    }),
    "E:/NF",
    { kind: "function", className: "AMyCharacter", name: "Jump" },
  );
  assert.equal(called, false);
  assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /not_ready/);
});

test("find references formats protocol hits for the model", async () => {
  const calls: JsonObject[] = [];
  const result = await runUnrealEditorFindReferences(
    deps([binding(true)], (_server, _tool, args) => {
      calls.push(args);
      return Promise.resolve(textResult(JSON.stringify({
        protocolVersion: 1,
        indexState: "warming",
        complete: false,
        references: [
          {
            kind: "call",
            assetPath: "/Game/Characters/BP_Hero.BP_Hero",
            graph: "EventGraph",
            nodeGuid: "112233445566778899AABBCCDDEEFF00",
            nodeTitle: "Jump",
          },
          { kind: "parent_class", assetPath: "/Game/Characters/BP_Hero.BP_Hero" },
        ],
      }), ToolReturnCode.Success));
    }),
    "E:/NF",
    { kind: "function", className: "AMyCharacter", name: "Jump", module: "NFGame" },
  );
  assert.equal(result.returnCode, ToolReturnCode.Success);
  assert.deepEqual(calls[0], {
    kind: "function",
    className: "AMyCharacter",
    name: "Jump",
    module: "NFGame",
    limit: 100,
  });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "";
  assert.match(text, /complete=false hits=2/);
  assert.match(text, /This list is partial/);
  assert.match(text, /nodeGuid=112233445566778899AABBCCDDEEFF00/);
  assert.match(text, /parent_class asset=\/Game\/Characters\/BP_Hero\.BP_Hero/);
});

test("open uses the reference address and maps editor errors", async () => {
  const missing = await runUnrealEditorOpen(
    deps([binding(true)], () => Promise.resolve(textResult(JSON.stringify({
      protocolVersion: 1,
      opened: false,
      error: "not_found",
      assetPath: "/Game/Missing.Missing",
    }), ToolReturnCode.Success))),
    "E:/NF",
    { assetPath: "/Game/Missing.Missing" },
  );
  assert.equal(missing.returnCode, ToolReturnCode.NotFound);

  let called = false;
  const invalid = await runUnrealEditorOpen(
    deps([binding(true)], () => {
      called = true;
      return Promise.resolve(textResult("no", ToolReturnCode.Success));
    }),
    "E:/NF",
    { assetPath: "/Game/Characters/BP_Hero.BP_Hero", nodeGuid: "bad" },
  );
  assert.equal(called, false);
  assert.equal(invalid.returnCode, ToolReturnCode.InvalidArguments);

  const opened = await runUnrealEditorOpen(
    deps([binding(true)], () => Promise.resolve(textResult(JSON.stringify({
      protocolVersion: 1,
      opened: true,
      focus: "node",
      assetPath: "/Game/Characters/BP_Hero.BP_Hero",
    }), ToolReturnCode.Success))),
    "E:/NF",
    {
      assetPath: "/Game/Characters/BP_Hero.BP_Hero",
      nodeGuid: "112233445566778899AABBCCDDEEFF00",
    },
  );
  assert.equal(opened.returnCode, ToolReturnCode.Success);
  assert.match(opened.content[0]?.type === "text" ? opened.content[0].text : "", /focus=node/);
});

test("Blueprint lookup for Find Usages returns structured hits and connection states", async () => {
  let calls = 0;
  const never: UnrealEditorCaller = () => {
    calls++;
    return Promise.resolve(textResult("no", ToolReturnCode.Success));
  };
  assert.deepEqual(
    await runUnrealBlueprintLookup(deps([], never), "E:/NF", { kind: "class", className: "ANFCharacter" }),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await runUnrealBlueprintLookup(deps([binding(false)], never), "E:/NF", { kind: "class", className: "ANFCharacter" }),
    { status: "not_ready" },
  );
  assert.equal(calls, 0);

  const sent: JsonObject[] = [];
  const found = await runUnrealBlueprintLookup(
    deps([binding(true)], (_server, _tool, args) => {
      sent.push(args);
      return Promise.resolve(textResult(JSON.stringify({
        protocolVersion: 1,
        indexState: "ready",
        complete: true,
        references: [
          { kind: "parent_class", assetPath: "/Game/Characters/BP_Hero.BP_Hero" },
          { kind: "bogus", assetPath: "/Game/X.X" },
        ],
      }), ToolReturnCode.Success));
    }),
    "E:/NF",
    { kind: "function", className: "ANFCharacter", name: "Jump" },
  );
  assert.deepEqual(sent[0], { kind: "function", className: "ANFCharacter", name: "Jump", limit: 200 });
  assert.deepEqual(found, {
    status: "ok",
    complete: true,
    references: [{ kind: "parent_class", assetPath: "/Game/Characters/BP_Hero.BP_Hero" }],
  });

  const broken = await runUnrealBlueprintLookup(
    deps([binding(true)], () => Promise.reject(new Error("pipe closed"))),
    "E:/NF",
    { kind: "class", className: "ANFCharacter" },
  );
  assert.deepEqual(broken, { status: "failed", message: "pipe closed" });
});

test("Blueprint open for Find Usages reports readable failures", async () => {
  const opened = await runUnrealBlueprintOpen(
    deps([binding(true)], (_server, _tool, args) => {
      assert.deepEqual(args, {
        assetPath: "/Game/Characters/BP_Hero.BP_Hero",
        nodeGuid: "112233445566778899AABBCCDDEEFF00",
      });
      return Promise.resolve(textResult(JSON.stringify({
        protocolVersion: 1,
        opened: true,
        focus: "node",
        assetPath: "/Game/Characters/BP_Hero.BP_Hero",
      }), ToolReturnCode.Success));
    }),
    "E:/NF",
    { assetPath: "/Game/Characters/BP_Hero.BP_Hero", nodeGuid: "112233445566778899AABBCCDDEEFF00" },
  );
  assert.deepEqual(opened, { ok: true });

  const missing = await runUnrealBlueprintOpen(
    deps([binding(true)], () => Promise.resolve(textResult(JSON.stringify({
      protocolVersion: 1,
      opened: false,
      error: "not_found",
      assetPath: "/Game/Missing.Missing",
    }), ToolReturnCode.Success))),
    "E:/NF",
    { assetPath: "/Game/Missing.Missing" },
  );
  assert.deepEqual(missing, { ok: false, message: "Unreal Editor could not find this asset." });

  const offline = await runUnrealBlueprintOpen(
    deps([], () => Promise.resolve(textResult("no", ToolReturnCode.Success))),
    "E:/NF",
    { assetPath: "/Game/Missing.Missing" },
  );
  assert.deepEqual(offline, { ok: false, message: "Unreal Editor is not connected to this project." });
});

test("Blueprint select for Find Usages needs the select capability and maps failures", async () => {
  const unsupported = await runUnrealBlueprintSelect(
    deps([binding(true)], () => {
      throw new Error("must not be called");
    }),
    "E:/NF",
    { assetPath: "/Game/Characters/BP_Hero.BP_Hero" },
  );
  assert.deepEqual(unsupported, { status: "unsupported" });

  const sent: JsonObject[] = [];
  const selected = await runUnrealBlueprintSelect(
    deps([binding(true, ["references", "open", "select"])], (_server, tool, args) => {
      sent.push(args);
      assert.equal(tool, "unreal_editor_select");
      return Promise.resolve(textResult(JSON.stringify({
        protocolVersion: 1,
        selected: true,
        assetPath: "/Game/Characters/BP_Hero.BP_Hero",
      }), ToolReturnCode.Success));
    }),
    "E:/NF",
    { assetPath: "/Game/Characters/BP_Hero.BP_Hero" },
  );
  assert.deepEqual(selected, { status: "ok" });
  assert.deepEqual(sent, [{ assetPath: "/Game/Characters/BP_Hero.BP_Hero" }]);

  const missing = await runUnrealBlueprintSelect(
    deps([binding(true, ["references", "open", "select"])], () => Promise.resolve(textResult(JSON.stringify({
      protocolVersion: 1,
      selected: false,
      error: "not_found",
      assetPath: "/Game/Missing.Missing",
    }), ToolReturnCode.Success))),
    "E:/NF",
    { assetPath: "/Game/Missing.Missing" },
  );
  assert.deepEqual(missing, { status: "failed", message: "Unreal Editor could not find this asset." });

  const offline = await runUnrealBlueprintSelect(
    deps([], () => Promise.resolve(textResult("no", ToolReturnCode.Success))),
    "E:/NF",
    { assetPath: "/Game/Missing.Missing" },
  );
  assert.deepEqual(offline, { status: "unavailable" });
});

test("a non-protocol tool result is an invalid response", async () => {
  const result: ToolExecuteResult = await runUnrealEditorFindReferences(
    deps([binding(true)], () => Promise.resolve(textResult("hello", ToolReturnCode.Success))),
    "E:/NF",
    { kind: "class", className: "AMyCharacter" },
  );
  assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
  assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /invalid response/);
});
