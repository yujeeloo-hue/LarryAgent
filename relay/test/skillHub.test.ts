/**
 * Skill Hub store — whole skill packages are AES-256-GCM envelopes in SQLite;
 * the console never sees a body, and SKILL.md frontmatter is regenerated from
 * the columns so the Hub description stays authoritative.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import { createSessionToken } from "../src/auth.ts";
import { createSkillHubEndpoints } from "../src/skillHubEndpoints.ts";
import {
  buildSkillPackage,
  normalizeSkillPackage,
  SkillHubOrderConflictError,
  SkillHubStore,
} from "../src/skillHubStore.ts";

const BODY = "Secret-body-sentinel-do-not-store-plainly.\n\nStep 1. Step 2.";
const FILE_BODY = "notes-body-sentinel";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "jellybot-skill-hub-"));
}

function zipOf(files: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.from(content, "utf8"));
  }
  return zip.toBuffer().toString("base64");
}

function skillMdBody(zipBase64: string): string {
  const zip = new AdmZip(Buffer.from(zipBase64, "base64"));
  return zip.getEntry("SKILL.md")!.getData().toString("utf8");
}

describe("skill hub store", () => {
  it("keeps bodies, file names and zip bytes out of the database file", () => {
    const dir = tempDataDir();
    const store = new SkillHubStore(dir);
    try {
      assert.equal(store.available, true);
      assert.equal(statSync(join(dir, "skill-hub.key")).mode & 0o777, 0o600);
      const snapshot = store.addSkills([
        { name: "alpha", description: "Alpha skill.", body: BODY },
        { name: "beta", description: "Beta skill.", body: "Beta body.", enabled: false },
      ]);
      assert.equal(snapshot.skills.length, 2);
      assert.equal(snapshot.skills[0]?.name, "alpha");
      assert.equal(snapshot.skills[1]?.enabled, false);

      // Supporting files arrive by pull; the store must keep them opaque too.
      const pulled = store.upsertByMatch({
        name: "gamma",
        enabled: true,
        zipBase64: zipOf({
          "SKILL.md": "---\nname: gamma\ndescription: Gamma skill.\n---\n\nGamma body.\n",
          "notes.md": FILE_BODY,
        }),
      });
      assert.equal(pulled.action, "added");

      const raw = readFileSync(store.dbPath);
      for (const secret of [BODY, FILE_BODY, "notes.md", "UEsDB"]) {
        assert.equal(raw.includes(secret), false, `database file leaked ${secret}`);
      }
      const text = JSON.stringify(store.snapshot());
      assert.equal(text.includes(BODY), false);
      assert.equal("body" in (snapshot.skills[0] as object), false);

      const detail = store.getDetail(snapshot.skills[0]!.id);
      assert.equal(detail.body, BODY);
      assert.deepEqual(detail.files, []);
      const gamma = store.findByName("gamma")!;
      assert.equal(gamma.fileCount, 1);
      assert.deepEqual(store.getDetail(gamma.id).files, [
        { path: "notes.md", size: Buffer.byteLength(FILE_BODY) },
      ]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("regenerates SKILL.md frontmatter from the columns on update", () => {
    const dir = tempDataDir();
    const store = new SkillHubStore(dir);
    try {
      const created = store.addSkills([
        { name: "alpha", description: "Alpha skill.", body: "Old body." },
      ]);
      const id = created.skills[0]!.id;
      store.updateSkill(id, { description: "Updated description.", body: "New body." });

      const transfer = store.getTransfer(id);
      assert.equal(transfer.description, "Updated description.");
      const markdown = skillMdBody(transfer.zipBase64);
      assert.match(markdown, /description: Updated description\./);
      assert.match(markdown, /New body\./);
      assert.equal(store.getDetail(id).body, "New body.");

      // rename rewrites the frontmatter name too
      store.updateSkill(id, { name: "alpha-renamed" });
      assert.match(skillMdBody(store.getTransfer(id).zipBase64), /name: alpha-renamed/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reorders skills and rejects stale orders", () => {
    const dir = tempDataDir();
    const store = new SkillHubStore(dir);
    try {
      const snapshot = store.addSkills([
        { name: "one", description: "One.", body: "1" },
        { name: "two", description: "Two.", body: "2" },
      ]);
      const ids = snapshot.skills.map((skill) => skill.id);
      const reordered = store.reorderSkills([ids[1]!, ids[0]!]);
      assert.deepEqual(reordered.skills.map((skill) => skill.name), ["two", "one"]);
      assert.throws(() => store.reorderSkills([ids[0]!]), SkillHubOrderConflictError);
      assert.throws(() => store.reorderSkills([ids[0]!, ids[0]!]), /duplicate/i);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upserts by name, keeping the hub id, and rejects bad packages", () => {
    const dir = tempDataDir();
    const store = new SkillHubStore(dir);
    try {
      const first = store.upsertByMatch({
        name: "alpha",
        enabled: true,
        zipBase64: zipOf({
          "SKILL.md": "---\nname: alpha\ndescription: Alpha skill.\n---\n\nFirst body.\n",
        }),
      });
      const second = store.upsertByMatch({
        name: "Alpha",
        enabled: false,
        zipBase64: zipOf({
          "SKILL.md": "---\nname: alpha\ndescription: Alpha pulled again.\n---\n\nSecond body.\n",
          "notes.md": "n",
        }),
      });
      assert.equal(first.action, "added");
      assert.equal(second.action, "overwritten");
      assert.equal(second.skillId, first.skillId);
      const row = store.findByName("alpha")!;
      assert.equal(row.description, "Alpha pulled again.");
      assert.equal(row.enabled, false);
      assert.equal(row.fileCount, 1);
      assert.equal(store.getDetail(row.id).body, "Second body.");

      assert.throws(
        () => store.upsertByMatch({ name: "bad name", enabled: true, zipBase64: "x" }),
        /lowercase slug/i,
      );
      assert.throws(
        () => store.upsertByMatch({ name: "broken", enabled: true, zipBase64: zipOf({ "SKILL.md": "x" }) }),
        /missing a description/i,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects duplicate or invalid skill names", () => {
    const dir = tempDataDir();
    const store = new SkillHubStore(dir);
    try {
      store.addSkills([{ name: "alpha", description: "Alpha.", body: "a" }]);
      assert.throws(
        () => store.addSkills([{ name: "alpha", description: "Again.", body: "b" }]),
        /already exists/i,
      );
      assert.throws(
        () => store.addSkills([{ name: "Bad Name", description: "x", body: "c" }]),
        /lowercase slug/i,
      );
      assert.throws(
        () => store.addSkills([{ name: "no-desc", description: "  ", body: "d" }]),
        /description is required/i,
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("clears order and device links when a skill is removed", () => {
    const dir = tempDataDir();
    const store = new SkillHubStore(dir);
    try {
      const snapshot = store.addSkills([
        { name: "alpha", description: "Alpha.", body: "a" },
        { name: "beta", description: "Beta.", body: "b" },
      ]);
      const [alpha, beta] = snapshot.skills;
      store.assignSkill("dev-1", alpha!.id);
      store.assignSkill("dev-1", beta!.id);
      assert.deepEqual(
        [...(store.snapshot().deviceSkillIds["dev-1"] ?? [])].sort(),
        [alpha!.id, beta!.id].sort(),
      );

      store.removeSkill(alpha!.id);
      const after = store.snapshot();
      assert.equal(after.skills.length, 1);
      assert.deepEqual(after.deviceSkillIds["dev-1"], [beta!.id]);
      assert.throws(() => store.removeSkill(alpha!.id), /not found/i);
      store.unassignSkill("dev-1", alpha!.id);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps package validation wired to the shared limits", () => {
    const pkg = normalizeSkillPackage(
      buildSkillPackage("alpha", "Alpha.", "body").toString("base64"),
    );
    assert.equal(pkg.files.length, 0);
  });
});

type FakeDeviceSkill = {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  zipBase64: string;
};

describe("skill hub console API", () => {
  async function withServer(
    options: { legacy?: boolean } = {},
    run: (ctx: {
      base: string;
      headers: Record<string, string>;
      store: SkillHubStore;
      device: Map<string, FakeDeviceSkill>;
      setOnline: (value: boolean) => void;
      audit: Array<{ action: string; detail?: string }>;
    }) => Promise<void>,
  ): Promise<void> {
    const dir = tempDataDir();
    const store = new SkillHubStore(dir);
    const device = new Map<string, FakeDeviceSkill>();
    let online = true;
    const audit: Array<{ action: string; detail?: string }> = [];
    const endpoints = createSkillHubEndpoints({
      skillHub: store,
      isDeviceOnline: () => online,
      onAudit: (_actor, action, detail) => audit.push({ action, detail }),
      callDevice: async (_deviceId, action, payload) => {
        const body = (payload ?? {}) as Record<string, unknown>;
        if (options.legacy) throw new Error(`unknown action: ${action}`);
        if (action === "listSyncSkills") {
          return {
            skills: [...device.values()].map((skill) => ({
              id: skill.id,
              name: skill.name,
              enabled: skill.enabled,
              description: skill.description,
              fileCount: normalizeSkillPackage(skill.zipBase64).files.length,
            })),
          };
        }
        if (action === "exportSyncSkill") {
          const found = device.get(String(body.skillId ?? ""));
          if (!found) throw new Error("Skill not found.");
          return {
            id: found.id,
            name: found.name,
            enabled: found.enabled,
            description: found.description,
            zipBase64: found.zipBase64,
          };
        }
        if (action === "upsertSyncSkill") {
          const name = String(body.name ?? "");
          const existing = [...device.values()].find(
            (skill) => skill.name.toLowerCase() === name.toLowerCase(),
          );
          const zipBase64 = String(body.zipBase64 ?? "");
          const fileCount = normalizeSkillPackage(zipBase64).files.length;
          if (existing) {
            existing.enabled = body.enabled !== false;
            existing.zipBase64 = zipBase64;
            return { id: existing.id, action: "overwritten", fileCount };
          }
          const created: FakeDeviceSkill = {
            id: `dev-k${device.size + 1}`,
            name,
            enabled: body.enabled !== false,
            description: String(body.description ?? ""),
            zipBase64,
          };
          device.set(created.id, created);
          return { id: created.id, action: "added", fileCount };
        }
        if (action === "removeSyncSkill") {
          const found = device.get(String(body.skillId ?? ""));
          if (!found) return { removed: false };
          device.delete(found.id);
          return { removed: true, id: found.id };
        }
        throw new Error(`unknown action: ${action}`);
      },
    });
    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const headers = {
      "content-type": "application/json",
      "x-auth-token": createSessionToken("tester").token,
    };
    try {
      await run({
        base,
        headers,
        store,
        device,
        setOnline: (value) => {
          online = value;
        },
        audit,
      });
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("guards the session token and exposes CRUD + detail without bodies in lists", async () => {
    await withServer({}, async ({ base, headers, store, audit }) => {
      const unauth = await fetch(`${base}/api/console/skill-hub`);
      assert.equal(unauth.status, 401);

      const created = await (await fetch(`${base}/api/console/skill-hub/skills`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          skills: [{ name: "alpha", description: "Alpha skill.", body: "Body sentinel." }],
        }),
      })).json() as { skills: Array<{ id: string; name: string; fileCount: number }> };
      assert.equal(created.skills.length, 1);
      const id = created.skills[0]!.id;
      assert.equal("body" in (created.skills[0] as object), false);

      const detail = await (await fetch(`${base}/api/console/skill-hub/skills/${id}`, { headers })).json() as {
        body: string;
        files: Array<{ path: string; size: number }>;
      };
      assert.equal(detail.body, "Body sentinel.");
      assert.deepEqual(detail.files, []);

      const patched = await (await fetch(`${base}/api/console/skill-hub/skills/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ description: "Alpha edited.", body: "Edited body." }),
      })).json() as { skills: Array<{ description: string }> };
      assert.equal(patched.skills[0]!.description, "Alpha edited.");
      assert.match(
        new AdmZip(store.getTransfer(id).zipBase64 ? Buffer.from(store.getTransfer(id).zipBase64, "base64") : Buffer.alloc(0))
          .getEntry("SKILL.md")!
          .getData()
          .toString("utf8"),
        /Edited body\./,
      );

      const reordered = await (await fetch(`${base}/api/console/skill-hub/skills/reorder`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skillIds: [id] }),
      })).json() as { skills: Array<{ id: string }> };
      assert.equal(reordered.skills[0]!.id, id);

      const conflict = await fetch(`${base}/api/console/skill-hub/skills/reorder`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skillIds: [] }),
      });
      assert.equal(conflict.status, 409);

      const tooLarge = await fetch(`${base}/api/console/skill-hub/skills`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skills: [{ name: "big", description: "Big.", body: "x".repeat(300 * 1024) }] }),
      });
      assert.equal(tooLarge.status, 413);

      const missing = await fetch(`${base}/api/console/skill-hub/skills/does-not-exist`, { headers });
      assert.equal(missing.status, 404);

      const removed = await (await fetch(`${base}/api/console/skill-hub/skills/${id}`, {
        method: "DELETE",
        headers,
      })).json() as { skills: unknown[] };
      assert.deepEqual(removed.skills, []);

      assert.deepEqual(
        audit.map((entry) => entry.action),
        ["skillHubAdd", "skillHubUpdate", "skillHubReorder", "skillHubDelete"],
      );
      assert.equal(audit.some((entry) => (entry.detail ?? "").includes("Body sentinel")), false);
    });
  });

  it("pushes, pulls and removes device skills, and downgrades legacy devices", async () => {
    await withServer({}, async ({ base, headers, store, device, setOnline, audit }) => {
      const created = await (await fetch(`${base}/api/console/skill-hub/skills`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skills: [{ name: "alpha", description: "Alpha skill.", body: "Hub body." }] }),
      })).json() as { skills: Array<{ id: string }> };
      const hubId = created.skills[0]!.id;

      device.set("dev-k0", {
        id: "dev-k0",
        name: "search",
        enabled: true,
        description: "Device search.",
        zipBase64: zipOf({
          "SKILL.md": "---\nname: search\ndescription: Device search.\n---\n\nSearch body.\n",
          "notes.md": "device notes",
        }),
      });

      const preview = await (await fetch(`${base}/api/console/skill-hub/devices/dev-1/sync-preview`, { headers })).json() as {
        supportsSync: boolean;
        hubSkills: Array<{ id: string; match: string }>;
        deviceSkills: Array<{ id: string; match: string; fileCount: number }>;
      };
      assert.equal(preview.supportsSync, true);
      assert.equal(preview.hubSkills[0]!.match, "add");
      assert.equal(preview.deviceSkills[0]!.match, "add");
      assert.equal(preview.deviceSkills[0]!.fileCount, 1);

      const pushed = await (await fetch(`${base}/api/console/skill-hub/devices/dev-1/push`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skillId: hubId }),
      })).json() as { action: string; deviceSkillId: string; snapshot: { deviceSkillIds: Record<string, string[]> } };
      assert.equal(pushed.action, "added");
      assert.deepEqual(pushed.snapshot.deviceSkillIds["dev-1"], [hubId]);
      const deviceCopy = [...device.values()].find((skill) => skill.name === "alpha")!;
      assert.equal(deviceCopy.description, "Alpha skill.");
      assert.match(
        new AdmZip(Buffer.from(deviceCopy.zipBase64, "base64")).getEntry("SKILL.md")!.getData().toString("utf8"),
        /Hub body\./,
      );
      assert.equal(JSON.stringify(pushed).includes("Hub body."), false);

      const pulled = await (await fetch(`${base}/api/console/skill-hub/devices/dev-1/pull`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skillId: "dev-k0" }),
      })).json() as { action: string; skillId: string; snapshot: { skills: Array<{ name: string; description: string }> } };
      assert.equal(pulled.action, "added");
      assert.equal(
        pulled.snapshot.skills.find((skill) => skill.name === "search")?.description,
        "Device search.",
      );
      // Pulled package keeps its supporting file and never returns the body.
      assert.deepEqual(store.getDetail(pulled.skillId).files.map((file) => file.path), ["notes.md"]);
      assert.equal(JSON.stringify(pulled).includes("Search body."), false);

      const removed = await (await fetch(`${base}/api/console/skill-hub/devices/dev-1/remove`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skillId: "dev-k0" }),
      })).json() as { removed: boolean; snapshot: { deviceSkillIds: Record<string, string[]> } };
      assert.equal(removed.removed, true);
      assert.equal([...device.values()].some((skill) => skill.name === "search"), false);
      assert.deepEqual(removed.snapshot.deviceSkillIds["dev-1"], [hubId]);

      setOnline(false);
      const offline = await fetch(`${base}/api/console/skill-hub/devices/dev-1/push`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skillId: hubId }),
      });
      assert.equal(offline.status, 409);

      assert.deepEqual(
        audit.map((entry) => entry.action),
        ["skillHubAdd", "skillHubPush", "skillHubPull", "skillHubRemoveFromDevice"],
      );
    });

    await withServer({ legacy: true }, async ({ base, headers }) => {
      const preview = await (await fetch(`${base}/api/console/skill-hub/devices/dev-1/sync-preview`, { headers })).json() as {
        supportsSync: boolean;
        deviceSkills: unknown[];
      };
      assert.equal(preview.supportsSync, false);
      assert.deepEqual(preview.deviceSkills, []);

      const created = await (await fetch(`${base}/api/console/skill-hub/skills`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skills: [{ name: "alpha", description: "Alpha skill.", body: "Hub body." }] }),
      })).json() as { skills: Array<{ id: string }> };
      const push = await fetch(`${base}/api/console/skill-hub/devices/dev-1/push`, {
        method: "POST",
        headers,
        body: JSON.stringify({ skillId: created.skills[0]!.id }),
      });
      assert.equal(push.status, 409);
      const pushBody = await push.json() as { error: string; detail: string };
      assert.equal(pushBody.error, "device_update_required");
      assert.match(pushBody.detail, /Update this device/);
    });
  });
});
