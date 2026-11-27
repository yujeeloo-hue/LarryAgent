import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chooseUnrealEditor,
  parseUnrealEditorCapabilities,
  parseUnrealEditorFindReferences,
  parseUnrealEditorOpen,
  parseUnrealEditorPushDeclaration,
  parseUnrealEditorSelect,
  parseUnrealEditorStatus,
  projectFileKey,
  readUnrealEditorOpenQuery,
  readUnrealEditorSymbolQuery,
  type UnrealEditorBinding,
} from "./editorProtocol.js";

const PROJECT = "E:/NF/Game.uproject";

function binding(patch: Partial<UnrealEditorBinding> & Pick<UnrealEditorBinding, "serverId">): UnrealEditorBinding {
  return {
    projectFile: PROJECT,
    projectKey: projectFileKey(PROJECT),
    engineVersion: "5.7.1",
    ready: true,
    capabilities: ["references", "open"],
    connectedAt: 1,
    source: "probe",
    lastSeenAt: 1,
    ...patch,
  };
}

const PUSH_STATUS = {
  protocol: "unreal-editor",
  protocolVersion: 1,
  projectFile: PROJECT,
  engineVersion: "5.7.1",
  ready: false,
  capabilities: ["references", "open", "status_push"],
};

test("push declarations live under experimental and require status_push", () => {
  assert.deepEqual(parseUnrealEditorPushDeclaration(null), { kind: "none" });
  assert.deepEqual(parseUnrealEditorPushDeclaration({ tools: {} }), { kind: "none" });
  assert.deepEqual(
    parseUnrealEditorPushDeclaration({ experimental: { other: {} } }),
    { kind: "none" },
  );
  assert.deepEqual(
    parseUnrealEditorPushDeclaration({
      experimental: { "unreal-editor": { ...PUSH_STATUS, capabilities: ["references", "open"] } },
    }),
    { kind: "invalid" },
  );
  const declared = parseUnrealEditorPushDeclaration({
    experimental: { "unreal-editor": { ...PUSH_STATUS, heartbeatIntervalMs: 2_000, shuttingDown: true } },
  });
  assert.equal(declared.kind, "push");
  if (declared.kind !== "push") return;
  assert.equal(declared.status.ready, false);
  assert.equal(declared.status.heartbeatIntervalMs, 2_000);
  assert.equal(declared.status.shuttingDown, false, "a handshake never means shutdown");
});

test("status notifications clamp the heartbeat and read shuttingDown", () => {
  assert.equal(parseUnrealEditorStatus(PUSH_STATUS)?.heartbeatIntervalMs, 10_000);
  assert.equal(parseUnrealEditorStatus({ ...PUSH_STATUS, heartbeatIntervalMs: 500 })?.heartbeatIntervalMs, 10_000);
  assert.equal(parseUnrealEditorStatus({ ...PUSH_STATUS, heartbeatIntervalMs: 60_001 })?.heartbeatIntervalMs, 10_000);
  assert.equal(parseUnrealEditorStatus({ ...PUSH_STATUS, heartbeatIntervalMs: 1_500.5 })?.heartbeatIntervalMs, 10_000);
  assert.equal(parseUnrealEditorStatus({ ...PUSH_STATUS, shuttingDown: true })?.shuttingDown, true);
  assert.equal(parseUnrealEditorStatus({ ...PUSH_STATUS, ready: "yes" }), null);
  assert.equal(parseUnrealEditorStatus([PUSH_STATUS]), null);
});

test("project file keys ignore slash and windows case", () => {
  assert.equal(projectFileKey("E:/NF/Foo/../Game.uproject"), projectFileKey("e:\\nf\\game.uproject"));
  assert.equal(projectFileKey(""), "");
});

test("capabilities require protocol, version, and both features", () => {
  const accepted = parseUnrealEditorCapabilities(JSON.stringify({
    protocol: "unreal-editor",
    protocolVersion: 1,
    projectFile: PROJECT,
    engineVersion: "5.7.1",
    ready: true,
    capabilities: ["open", "references", "later"],
  }));
  assert.equal(accepted?.projectFile, PROJECT);
  assert.equal(accepted?.ready, true);

  assert.equal(parseUnrealEditorCapabilities(JSON.stringify({
    protocol: "vendor-mcp",
    protocolVersion: 1,
    projectFile: PROJECT,
    engineVersion: "5.7.1",
    ready: true,
    capabilities: ["references", "open"],
  })), null);
  assert.equal(parseUnrealEditorCapabilities(JSON.stringify({
    protocol: "unreal-editor",
    protocolVersion: 2,
    projectFile: PROJECT,
    engineVersion: "5.7.1",
    ready: true,
    capabilities: ["references", "open"],
  })), null);
  assert.equal(parseUnrealEditorCapabilities(JSON.stringify({
    protocol: "unreal-editor",
    protocolVersion: 1,
    projectFile: PROJECT,
    engineVersion: "5.7.1",
    ready: true,
    capabilities: ["references"],
  })), null);
});

test("find-reference parsing keeps known hits and drops the rest", () => {
  const parsed = parseUnrealEditorFindReferences(JSON.stringify({
    protocolVersion: 1,
    indexState: "warming",
    complete: false,
    references: [
      {
        kind: "call",
        assetPath: "/Game/Characters/BP_Hero.BP_Hero",
        graph: "EventGraph",
        graphGuid: "A1B2C3D44E5F60718293A4B5C6D7E8F9",
        nodeGuid: "not-a-guid",
        nodeTitle: "Jump",
      },
      { kind: "mystery", assetPath: "/Game/Characters/BP_Hero.BP_Hero" },
    ],
  }));
  assert.ok(parsed);
  assert.equal(parsed.complete, false);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.references.length, 1);
  assert.equal(parsed.references[0]?.nodeGuid, undefined);
  assert.equal(parsed.references[0]?.graphGuid, "A1B2C3D44E5F60718293A4B5C6D7E8F9");
});

test("open parsing requires focus or a known error", () => {
  const opened = parseUnrealEditorOpen(JSON.stringify({
    protocolVersion: 1,
    opened: true,
    focus: "node",
    assetPath: "/Game/Characters/BP_Hero.BP_Hero",
  }));
  assert.equal(opened?.focus, "node");
  const missing = parseUnrealEditorOpen(JSON.stringify({
    protocolVersion: 1,
    opened: false,
    error: "not_found",
    assetPath: "/Game/Characters/BP_Hero.BP_Hero",
  }));
  assert.equal(missing?.error, "not_found");
  assert.equal(parseUnrealEditorOpen(JSON.stringify({
    protocolVersion: 1,
    opened: true,
    assetPath: "/Game/Characters/BP_Hero.BP_Hero",
  })), null);
});

test("select parsing requires a boolean selection and a known error", () => {
  const selected = parseUnrealEditorSelect(JSON.stringify({
    protocolVersion: 1,
    selected: true,
    assetPath: "/Game/Characters/BP_Hero.BP_Hero",
  }));
  assert.equal(selected?.selected, true);
  const missing = parseUnrealEditorSelect(JSON.stringify({
    protocolVersion: 1,
    selected: false,
    error: "not_found",
    assetPath: "/Game/Characters/BP_Hero.BP_Hero",
  }));
  assert.equal(missing?.error, "not_found");
  assert.equal(parseUnrealEditorSelect(JSON.stringify({
    protocolVersion: 1,
    selected: false,
    error: "opened",
    assetPath: "/Game/Characters/BP_Hero.BP_Hero",
  })), null);
  assert.equal(parseUnrealEditorSelect(JSON.stringify({
    protocolVersion: 1,
    selected: true,
    assetPath: "Game/BP_Hero",
  })), null);
});

test("symbol and open queries reject malformed fields", () => {
  const symbol = readUnrealEditorSymbolQuery({
    kind: "function",
    className: "AMyCharacter",
    name: "Jump",
    module: "NFGame",
    limit: "20",
  });
  assert.equal(symbol.ok, true);
  if (symbol.ok) assert.equal(symbol.query.limit, 20);

  assert.equal(readUnrealEditorSymbolQuery({ kind: "function", className: "AMyCharacter" }).ok, false);
  const opened = readUnrealEditorOpenQuery({
    assetPath: "/Game/Characters/BP_Hero.BP_Hero",
    nodeGuid: "112233445566778899AABBCCDDEEFF00",
  });
  assert.equal(opened.ok, true);
  assert.equal(readUnrealEditorOpenQuery({
    assetPath: "/Game/Characters/BP_Hero.BP_Hero",
    nodeGuid: "1122",
  }).ok, false);
});

test("editor choice prefers a ready session, then the newest", () => {
  const key = projectFileKey(PROJECT);
  const olderReady = binding({ serverId: "old", connectedAt: 1 });
  const newerCold = binding({ serverId: "cold", ready: false, connectedAt: 9 });
  const newerReady = binding({ serverId: "new", connectedAt: 4 });
  const other = binding({
    serverId: "other",
    projectFile: "E:/Other/Other.uproject",
    projectKey: projectFileKey("E:/Other/Other.uproject"),
    connectedAt: 20,
  });
  assert.equal(chooseUnrealEditor([newerCold, olderReady, other], key)?.serverId, "old");
  assert.equal(chooseUnrealEditor([olderReady, newerReady], key)?.serverId, "new");
  assert.equal(chooseUnrealEditor([other], key), null);
});
