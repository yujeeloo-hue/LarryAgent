import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CocoRepository } from "../coco/repository.js";
import type { CocoMcpEvent } from "../coco/types.js";
import { defaultSettings } from "../coco/validation.js";
import { postNotification, type NotificationCenterEvent } from "../events/notificationCenter.js";
import { createCocoEventSources } from "./cocoEventSources.js";
import { createCocoContextBuilder } from "./cocoService.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";
import type { SessionStore } from "./sessionRuntime.js";

function makeHarness(options?: { enabled?: boolean }) {
  const repository = new CocoRepository(new DatabaseSync(":memory:"));
  let enabled = options?.enabled ?? true;
  const deps = {
    repository,
    alive: () => true,
    engine: () => ({ settings: () => ({ enabled }) }),
    store: { listSessions: () => [], listWorkspaces: () => [] },
    context: () => ({ workspaces: [], sessions: [] }),
  } as unknown as CocoServiceDeps;
  return {
    repository,
    sources: createCocoEventSources(deps),
    setEnabled: (value: boolean) => {
      enabled = value;
    },
  };
}

function mcpNotification(
  method: string,
  serverId: string,
  data: NotificationCenterEvent["params"],
): void {
  postNotification({
    eventName: method,
    params: { serverId, serverName: `Server ${serverId}`, data },
    sender: {},
  });
}

/** Same dedup key the adapter computes (method + serverId + data). */
function expectedId(method: string, serverId: string, data: unknown): string {
  return createHash("sha256")
    .update(`${method}\n${serverId}\n${JSON.stringify(data ?? null)}`)
    .digest("hex");
}

test("records one app-level mcpEvent per MCP-originated notification", () => {
  const h = makeHarness();
  try {
    mcpNotification("notifications/message", "srv-1", { level: "info" });
    const rows = h.repository.list<CocoMcpEvent>("mcpEvent");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.method, "notifications/message");
    assert.equal(rows[0]?.serverId, "srv-1");
    assert.equal(rows[0]?.serverName, "Server srv-1");
    assert.equal(typeof rows[0]?.at, "number");
  } finally {
    h.sources.stop();
  }
});

test("dedups identical notifications; distinct payloads each record", () => {
  const h = makeHarness();
  try {
    mcpNotification("notifications/jellybot/demo", "srv", { payload: 1 });
    mcpNotification("notifications/jellybot/demo", "srv", { payload: 1 });
    assert.equal(h.repository.list<CocoMcpEvent>("mcpEvent").length, 1);
    mcpNotification("notifications/jellybot/demo", "srv", { payload: 2 });
    assert.equal(h.repository.list<CocoMcpEvent>("mcpEvent").length, 2);
  } finally {
    h.sources.stop();
  }
});

test("ignores events that are not MCP-originated (no serverId/serverName)", () => {
  const h = makeHarness();
  try {
    postNotification({ eventName: "anything/else", params: {}, sender: {} });
    postNotification({
      eventName: "also/not-mcp",
      params: { serverId: "srv-1", serverName: 42 },
      sender: {},
    });
    assert.equal(h.repository.list<CocoMcpEvent>("mcpEvent").length, 0);
  } finally {
    h.sources.stop();
  }
});

test("does not record while CoCo is disabled", () => {
  const h = makeHarness({ enabled: false });
  try {
    mcpNotification("notifications/message", "srv-1", {});
    assert.equal(h.repository.list<CocoMcpEvent>("mcpEvent").length, 0);
    h.setEnabled(true);
    mcpNotification("notifications/message", "srv-1", {});
    assert.equal(h.repository.list<CocoMcpEvent>("mcpEvent").length, 1);
  } finally {
    h.sources.stop();
  }
});

test("trims the mcpEvent table to the 200-row retention cap", () => {
  const h = makeHarness();
  try {
    for (let i = 0; i < 205; i++) {
      mcpNotification("notifications/jellybot/n", "srv", { i });
    }
    const rows = h.repository.list<CocoMcpEvent>("mcpEvent");
    assert.equal(rows.length, 200);
    const oldest = expectedId("notifications/jellybot/n", "srv", { i: 0 });
    const newest = expectedId("notifications/jellybot/n", "srv", { i: 204 });
    assert.equal(h.repository.get<CocoMcpEvent>("mcpEvent", oldest), undefined);
    assert.ok(h.repository.get<CocoMcpEvent>("mcpEvent", newest));
  } finally {
    h.sources.stop();
  }
});

test("stop() unsubscribes the NotificationCenter listener", () => {
  const h = makeHarness();
  h.sources.stop();
  mcpNotification("notifications/message", "srv-1", {});
  assert.equal(h.repository.list<CocoMcpEvent>("mcpEvent").length, 0);
});

test("context builder includes only the 20 most recent mcpEvents (see, don't act)", () => {
  const repository = new CocoRepository(new DatabaseSync(":memory:"));
  for (let i = 0; i < 25; i++) {
    repository.put("mcpEvent", {
      id: `ev-${i}`,
      method: `notifications/jellybot/${i}`,
      serverId: "srv",
      serverName: "S",
      at: i,
    } satisfies CocoMcpEvent);
  }
  const store = {
    listWorkspaces: () => [
      { id: "ws-1", name: "Proj", path: mkdtempSync(join(tmpdir(), "jb-coco-ctx-")) },
    ],
    listSessions: () => [],
  } as unknown as SessionStore;
  const context = createCocoContextBuilder(store, repository)({
    ...defaultSettings(),
    enabled: true,
  });
  assert.equal(context.mcpEvents?.length, 20);
  assert.equal(context.mcpEvents?.[0]?.id, "ev-5");
  assert.equal(context.mcpEvents?.[19]?.id, "ev-24");
  const empty = createCocoContextBuilder(
    store,
    new CocoRepository(new DatabaseSync(":memory:")),
  )({ ...defaultSettings(), enabled: true });
  assert.equal(empty.mcpEvents, undefined);
});
