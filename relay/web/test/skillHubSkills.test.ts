import assert from "node:assert/strict";
import test from "node:test";
import {
  SkillHubController,
  type DeviceSyncSkillPreview,
  type DeviceSyncSkill,
  type SkillHubDetail,
  type SkillHubSkill,
} from "../src/SkillHubController.js";

const realFetch = globalThis.fetch;
const apiRoot = "http://relay.test/api/console/skill-hub";

type Snapshot = DeviceSyncSkillPreview["snapshot"];
type Call = { path: string; method: string; body: unknown };
type Reply = { status?: number; payload: unknown };
type Handler = (call: Call) => Reply | Promise<Reply>;

let seq = 0;
function hubSkill(id: string, name = id): SkillHubSkill {
  seq += 1;
  return { id, name, enabled: true, description: `${name} description`, fileCount: 0, createdAt: seq };
}

function hubDetail(skill: SkillHubSkill, body = "Skill body."): SkillHubDetail {
  return { ...skill, body, files: [{ path: "notes.md", size: 12 }] };
}

function deviceSkill(id: string, name = id): DeviceSyncSkill {
  return { id, name, enabled: true, description: `${name} description`, fileCount: 1, match: "add" };
}

function snapshot(skills: SkillHubSkill[] = []): Snapshot {
  return { skills, deviceSkillIds: {} };
}

function preview(
  deviceSkills: DeviceSyncSkill[],
  snap = snapshot(),
  deviceOnline = true,
): DeviceSyncSkillPreview {
  return {
    deviceOnline,
    supportsSync: deviceOnline,
    deviceSkills,
    snapshot: snap,
    hubSkills: snap.skills.map((skill) => ({ ...skill, match: "add" })),
  };
}

function setup(handler: Handler) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      path: String(input).slice(apiRoot.length),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const reply = await handler(call);
    return new Response(JSON.stringify(reply.payload), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const controller = new SkillHubController({
    apiBase: () => "http://relay.test/",
    sessionToken: () => "session-1",
  });
  return { controller, calls };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test("device previews match skills by name in both directions and keep the last list when offline", async () => {
  const inHub = hubSkill("hub-1", "shared-skill");
  const snap = snapshot([inHub]);
  snap.deviceSkillIds = { mac: [inHub.id] };
  const { controller } = setup(({ path, method }) => {
    if (path === "/devices/mac/sync-preview") {
      return { payload: preview([deviceSkill("local-1"), deviceSkill("shared-1", "Shared-Skill")], snap) };
    }
    if (path === "/devices/pc/sync-preview") {
      return { payload: preview([], snap, false) };
    }
    if (path.startsWith("/skills/") && method === "DELETE") {
      return { payload: snapshot() };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });

  await controller.refresh();
  const mac = await controller.loadDeviceSyncPreview("mac");
  assert.equal(mac.hubSkills.find((skill) => skill.id === "hub-1")?.match, "overwrite");
  assert.equal(mac.deviceSkills.find((skill) => skill.id === "local-1")?.match, "add");
  assert.equal(mac.deviceSkills.find((skill) => skill.id === "shared-1")?.match, "overwrite");

  const offline = await controller.loadDeviceSyncPreview("pc");
  assert.equal(offline.deviceOnline, false);
  assert.deepEqual(controller.getDeviceSyncPreview("mac")?.deviceSkills.length, 2);
});

test("detail fetches are cached, shared while in flight, and invalidated on writes", async () => {
  let detailCalls = 0;
  const skill = hubSkill("skill-1", "alpha");
  const { controller } = setup(({ path, method }) => {
    if (path === "" && method === "GET") return { payload: snapshot([skill]) };
    if (path === "/skills/skill-1" && method === "GET") {
      detailCalls += 1;
      return { payload: hubDetail(skill) };
    }
    if (path === "/skills/skill-1" && method === "PATCH") {
      return { payload: snapshot([{ ...skill, description: "edited" }]) };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });

  await controller.refresh();
  const [first, second] = await Promise.all([
    controller.loadDetail("skill-1"),
    controller.loadDetail("skill-1"),
  ]);
  assert.equal(first.body, "Skill body.");
  assert.deepEqual(second.files, [{ path: "notes.md", size: 12 }]);
  assert.equal(detailCalls, 1);
  assert.equal(controller.getDetail("skill-1")?.body, "Skill body.");

  await controller.updateSkill("skill-1", { description: "edited" });
  assert.equal(controller.getDetail("skill-1"), null);
});

test("add, reorder and remove keep the selection honest", async () => {
  const alpha = hubSkill("a", "alpha");
  const beta = hubSkill("b", "beta");
  const { controller } = setup(({ path, method, body }) => {
    if (path === "" && method === "GET") return { payload: snapshot([alpha, beta]) };
    if (path === "/skills" && method === "POST") {
      const name = (body as { skills: Array<{ name: string }> }).skills[0]!.name;
      return { payload: snapshot([alpha, beta, hubSkill("c", name)]) };
    }
    if (path === "/skills/reorder" && method === "POST") {
      const ids = (body as { skillIds: string[] }).skillIds;
      const byId = new Map([alpha, beta, hubSkill("c", "gamma")].map((skill) => [skill.id, skill]));
      return { payload: snapshot(ids.map((id) => byId.get(id)!)) };
    }
    if (path === "/skills/b" && method === "DELETE") return { payload: snapshot([alpha]) };
    throw new Error(`unexpected ${method} ${path}`);
  });

  await controller.refresh();
  assert.equal(controller.getSnapshot().selectedSkillId, "a");

  await controller.addSkill({ name: "gamma", description: "Gamma.", body: "Body." });
  assert.equal(controller.getSnapshot().selectedSkillId, "c");

  await controller.reorderSkills(["b", "a", "c"]);
  assert.deepEqual(controller.getSnapshot().skills.map((skill) => skill.name), ["beta", "alpha", "gamma"]);
  await assert.rejects(() => controller.reorderSkills(["a"]), /Refresh the list/);

  await controller.removeSkill("b");
  assert.deepEqual(controller.getSnapshot().skills.map((skill) => skill.id), ["a"]);
  assert.equal(controller.getSnapshot().selectedSkillId, "a");
});

test("push, pull and remove report progress and surface failures", async () => {
  const hub = hubSkill("hub-1", "shared");
  const hubSkills: SkillHubSkill[] = [hub];
  const deviceSkills: DeviceSyncSkill[] = [deviceSkill("dev-1", "local")];
  const current = () => snapshot([...hubSkills]);
  const { controller, calls } = setup(({ path, method }) => {
    if (path === "" && method === "GET") return { payload: current() };
    if (path === "/devices/mac/sync-preview") {
      return { payload: preview([...deviceSkills], current()) };
    }
    if (path === "/devices/mac/push") {
      deviceSkills.push(deviceSkill("dev-2", "shared"));
      return {
        payload: { action: "added", deviceSkillId: "dev-2", fileCount: 2, snapshot: current() },
      };
    }
    if (path === "/devices/mac/pull") {
      const pulled = hubSkill("hub-2", "local");
      hubSkills.push(pulled);
      return { payload: { action: "added", skillId: "hub-2", snapshot: current() } };
    }
    if (path === "/devices/mac/remove") {
      const index = deviceSkills.findIndex((skill) => skill.id === "dev-2");
      if (index >= 0) deviceSkills.splice(index, 1);
      return { payload: { removed: true, snapshot: current() } };
    }
    if (path === "/devices/win/sync-preview") {
      return { status: 409, payload: { error: "device offline" } };
    }
    throw new Error(`unexpected ${method} ${path}`);
  });

  await controller.refresh();
  await controller.loadDeviceSyncPreview("mac");

  const pushed = await controller.pushSkillToDevice("mac", "hub-1");
  assert.equal(pushed.action, "add");
  assert.equal(controller.getSyncAnnouncement("mac"), "Added shared.");
  assert.deepEqual(
    controller.getDeviceSyncPreview("mac")!.deviceSkills.map((skill) => skill.id).sort(),
    ["dev-1", "dev-2"],
  );
  assert.equal(controller.getSyncPending("mac"), null);

  const pulled = await controller.pullSkillFromDevice("mac", "dev-1");
  assert.equal(pulled.action, "add");
  assert.equal(controller.getSnapshot().skills.some((skill) => skill.id === "hub-2"), true);

  await controller.removeSkillFromDevice("mac", "dev-2");
  assert.equal(controller.getDeviceOperation("mac", "remove", "dev-2")?.status, "done");

  await assert.rejects(() => controller.loadDeviceSyncPreview("win"), /device offline/);
  assert.equal(controller.getSyncError("win"), "device offline");
  assert.equal(calls.some((call) => call.path === "/devices/win/push"), false);
});

test("legacy devices surface the update hint instead of a raw action error", async () => {
  const { controller } = setup(({ path }) => {
    if (path === "") return { payload: snapshot([hubSkill("hub-1", "shared")]) };
    if (path === "/devices/mac/push") {
      return {
        status: 409,
        payload: {
          error: "device_update_required",
          detail: "Update this device to manage skills remotely.",
        },
      };
    }
    throw new Error(`unexpected ${path}`);
  });

  await controller.refresh();
  await assert.rejects(
    () => controller.pushSkillToDevice("mac", "hub-1"),
    /Update this device to manage skills remotely\./,
  );
  assert.equal(controller.getDeviceOperation("mac", "push", "hub-1")?.status, "failed");
});
