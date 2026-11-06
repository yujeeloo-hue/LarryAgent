/**
 * Console Skill Hub API. Session-token guarded. Responses carry skill
 * metadata and file listings only — never the SKILL.md body or the package
 * itself. Device push/pull orchestrates Relay-originated encrypted device RPC
 * and mirrors the MCP Hub endpoints one for one.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifySessionToken } from "./auth.js";
import type { DeviceAction } from "./protocol.js";
import {
  skillHubMatchKey,
  SkillHubOrderConflictError,
  SkillHubStore,
  type SkillHubSnapshot,
  type SkillHubUpdatePatch,
} from "./skillHubStore.js";

const PREFIX = "/api/console/skill-hub";
/** Skill packages travel as base64 zips — 12 MB covers an 8 MB package. */
const MAX_BODY_BYTES = 12 * 1024 * 1024;

/** Device-side public skill (listSyncSkills result rows). */
type DeviceSyncSkill = {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  fileCount: number;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function matchAction(source: { name: string }, targets: Array<{ name: string }>): "add" | "overwrite" {
  const key = skillHubMatchKey(source.name);
  return targets.some((target) => skillHubMatchKey(target.name) === key) ? "overwrite" : "add";
}

function isUnsupportedSyncError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unknown action/i.test(message);
}

function isTooLargeError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /too large|body too large/i.test(message);
}

type SkillHubEndpointDeps = {
  skillHub: SkillHubStore;
  isDeviceOnline?: (deviceId: string) => boolean;
  callDevice?: (deviceId: string, action: DeviceAction, payload?: unknown) => Promise<unknown>;
  onAudit?: (actor: string, action: string, detail?: string) => void;
};

export function createSkillHubEndpoints(deps: SkillHubEndpointDeps): {
  handle(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
} {
  const snapshotResponse = (res: ServerResponse, snapshot: SkillHubSnapshot) => json(res, 200, snapshot);

  const listDeviceSkills = async (
    callDevice: NonNullable<SkillHubEndpointDeps["callDevice"]>,
    deviceId: string,
  ): Promise<DeviceSyncSkill[]> => {
    const result = await callDevice(deviceId, "listSyncSkills", {}) as { skills?: DeviceSyncSkill[] };
    return Array.isArray(result?.skills) ? result.skills : [];
  };

  return {
    async handle(pathname, req, res) {
      if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return false;
      const session = verifySessionToken(req.headers["x-auth-token"]);
      if (!session) {
        json(res, 401, { error: "invalid_session" });
        return true;
      }
      if (!deps.skillHub.available) {
        json(res, 503, { error: "skill_hub_unavailable", reason: deps.skillHub.unavailableReason });
        return true;
      }
      try {
        if (req.method === "GET" && pathname === PREFIX) {
          snapshotResponse(res, deps.skillHub.snapshot());
          return true;
        }

        if (req.method === "POST" && pathname === `${PREFIX}/skills`) {
          const body = await readJsonBody(req);
          if (!Array.isArray(body.skills)) {
            json(res, 400, { error: "invalid_skills" });
            return true;
          }
          const snapshot = deps.skillHub.addSkills(body.skills.map((item) => {
            if (!item || typeof item !== "object") throw new Error("invalid skill payload");
            const row = item as Record<string, unknown>;
            return {
              name: typeof row.name === "string" ? row.name : "",
              description: typeof row.description === "string" ? row.description : "",
              body: typeof row.body === "string" ? row.body : "",
              enabled: row.enabled !== false,
            };
          }));
          deps.onAudit?.(session.username, "skillHubAdd", `added ${body.skills.length} skills`);
          snapshotResponse(res, snapshot);
          return true;
        }

        if (req.method === "POST" && pathname === `${PREFIX}/skills/reorder`) {
          const body = await readJsonBody(req);
          if (!Array.isArray(body.skillIds) || body.skillIds.some((id) => typeof id !== "string" || !id.trim())) {
            json(res, 400, { error: "invalid_skill_order" });
            return true;
          }
          const snapshot = deps.skillHub.reorderSkills(body.skillIds);
          deps.onAudit?.(session.username, "skillHubReorder", `ordered ${body.skillIds.length} skills`);
          snapshotResponse(res, snapshot);
          return true;
        }

        const skillMatch = /^\/api\/console\/skill-hub\/skills\/([^/]+)$/.exec(pathname);
        if (skillMatch) {
          const skillId = decodeURIComponent(skillMatch[1]!);
          if (req.method === "GET") {
            json(res, 200, deps.skillHub.getDetail(skillId));
            return true;
          }
          if (req.method === "PATCH") {
            const body = await readJsonBody(req);
            const patch: SkillHubUpdatePatch = {};
            if (typeof body.name === "string") patch.name = body.name;
            if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
            if (typeof body.description === "string") patch.description = body.description;
            if (typeof body.body === "string") patch.body = body.body;
            if (
              patch.name === undefined &&
              patch.enabled === undefined &&
              patch.description === undefined &&
              patch.body === undefined
            ) {
              json(res, 400, { error: "invalid_patch" });
              return true;
            }
            const snapshot = deps.skillHub.updateSkill(skillId, patch);
            const name = patch.name ?? deps.skillHub.getTransfer(skillId).name;
            deps.onAudit?.(session.username, "skillHubUpdate", name.slice(0, 64));
            snapshotResponse(res, snapshot);
            return true;
          }
          if (req.method === "DELETE") {
            const transfer = deps.skillHub.getTransfer(skillId);
            const snapshot = deps.skillHub.removeSkill(skillId);
            deps.onAudit?.(session.username, "skillHubDelete", transfer.name.slice(0, 64));
            snapshotResponse(res, snapshot);
            return true;
          }
        }

        const previewMatch = /^\/api\/console\/skill-hub\/devices\/([^/]+)\/sync-preview$/.exec(pathname);
        if (previewMatch && req.method === "GET") {
          const deviceId = decodeURIComponent(previewMatch[1]!);
          const online = deps.isDeviceOnline?.(deviceId) === true;
          const hubSkills = deps.skillHub.snapshot().skills;
          if (!online || !deps.callDevice) {
            json(res, 200, {
              deviceOnline: online,
              supportsSync: false,
              hubSkills: hubSkills.map((skill) => ({ ...skill, match: "add" as const })),
              deviceSkills: [] as Array<DeviceSyncSkill & { match: "add" | "overwrite" }>,
              snapshot: deps.skillHub.snapshot(),
            });
            return true;
          }
          try {
            const deviceSkills = await listDeviceSkills(deps.callDevice, deviceId);
            json(res, 200, {
              deviceOnline: true,
              supportsSync: true,
              hubSkills: hubSkills.map((skill) => ({
                ...skill,
                match: matchAction(skill, deviceSkills),
              })),
              deviceSkills: deviceSkills.map((skill) => ({
                ...skill,
                match: matchAction(skill, hubSkills),
              })),
              snapshot: deps.skillHub.snapshot(),
            });
          } catch (err) {
            if (isUnsupportedSyncError(err)) {
              json(res, 200, {
                deviceOnline: true,
                supportsSync: false,
                hubSkills: hubSkills.map((skill) => ({ ...skill, match: "add" as const })),
                deviceSkills: [],
                snapshot: deps.skillHub.snapshot(),
              });
              return true;
            }
            throw err;
          }
          return true;
        }

        const pushMatch = /^\/api\/console\/skill-hub\/devices\/([^/]+)\/push$/.exec(pathname);
        if (pushMatch && req.method === "POST") {
          const deviceId = decodeURIComponent(pushMatch[1]!);
          if (!deps.callDevice || deps.isDeviceOnline?.(deviceId) !== true) {
            json(res, 409, { error: "device offline" });
            return true;
          }
          const body = await readJsonBody(req);
          const skillId = typeof body.skillId === "string" ? body.skillId.trim() : "";
          if (!skillId) {
            json(res, 400, { error: "skillId required" });
            return true;
          }
          const transfer = deps.skillHub.getTransfer(skillId);
          const result = await deps.callDevice(deviceId, "upsertSyncSkill", {
            name: transfer.name,
            enabled: transfer.enabled,
            description: transfer.description,
            zipBase64: transfer.zipBase64,
          }) as { id?: string; action?: string; fileCount?: number };
          const snapshot = deps.skillHub.assignSkill(deviceId, skillId);
          deps.onAudit?.(
            session.username,
            "skillHubPush",
            `${deviceId} · ${transfer.name.slice(0, 64)} · ${result.action ?? "ok"}`,
          );
          json(res, 200, {
            action: result.action === "overwritten" ? "overwritten" : "added",
            deviceSkillId: typeof result.id === "string" ? result.id : null,
            fileCount: typeof result.fileCount === "number"
              ? result.fileCount
              : (snapshot.skills.find((skill) => skill.id === skillId)?.fileCount ?? 0),
            snapshot,
          });
          return true;
        }

        const pullMatch = /^\/api\/console\/skill-hub\/devices\/([^/]+)\/pull$/.exec(pathname);
        if (pullMatch && req.method === "POST") {
          const deviceId = decodeURIComponent(pullMatch[1]!);
          if (!deps.callDevice || deps.isDeviceOnline?.(deviceId) !== true) {
            json(res, 409, { error: "device offline" });
            return true;
          }
          const body = await readJsonBody(req);
          const skillId = typeof body.skillId === "string" ? body.skillId.trim() : "";
          if (!skillId) {
            json(res, 400, { error: "skillId required" });
            return true;
          }
          const exported = await deps.callDevice(deviceId, "exportSyncSkill", { skillId }) as {
            name?: unknown;
            enabled?: unknown;
            description?: unknown;
            zipBase64?: unknown;
          };
          if (
            typeof exported?.name !== "string" ||
            !exported.name.trim() ||
            typeof exported.zipBase64 !== "string" ||
            !exported.zipBase64
          ) {
            json(res, 400, { error: "invalid device skill export" });
            return true;
          }
          const upserted = deps.skillHub.upsertByMatch({
            name: exported.name,
            enabled: exported.enabled !== false,
            description: typeof exported.description === "string" ? exported.description : "",
            zipBase64: exported.zipBase64,
          });
          const snapshot = deps.skillHub.assignSkill(deviceId, upserted.skillId);
          deps.onAudit?.(
            session.username,
            "skillHubPull",
            `${deviceId} · ${upserted.skillId.slice(0, 8)} · ${upserted.action}`,
          );
          json(res, 200, {
            action: upserted.action,
            skillId: upserted.skillId,
            snapshot,
          });
          return true;
        }

        const removeMatch = /^\/api\/console\/skill-hub\/devices\/([^/]+)\/remove$/.exec(pathname);
        if (removeMatch && req.method === "POST") {
          const deviceId = decodeURIComponent(removeMatch[1]!);
          if (!deps.callDevice || deps.isDeviceOnline?.(deviceId) !== true) {
            json(res, 409, { error: "device offline" });
            return true;
          }
          const body = await readJsonBody(req);
          const deviceSkillId = typeof body.skillId === "string" ? body.skillId.trim() : "";
          if (!deviceSkillId) {
            json(res, 400, { error: "skillId required" });
            return true;
          }
          const deviceSkills = await listDeviceSkills(deps.callDevice, deviceId);
          const target = deviceSkills.find((skill) => skill.id === deviceSkillId);
          if (!target) {
            json(res, 200, { removed: false, deviceSkillId, snapshot: deps.skillHub.snapshot() });
            return true;
          }
          const removed = await deps.callDevice(deviceId, "removeSyncSkill", {
            skillId: deviceSkillId,
          }) as { removed?: boolean };
          let snapshot = deps.skillHub.snapshot();
          // Drop hub associations for this name once no same-name device row
          // remains — the device list stays authoritative for the UI.
          if (removed.removed === true && !deviceSkills.some((skill) =>
            skill.id !== deviceSkillId && skillHubMatchKey(skill.name) === skillHubMatchKey(target.name))) {
            for (const skill of snapshot.skills) {
              if (skillHubMatchKey(skill.name) === skillHubMatchKey(target.name)) {
                snapshot = deps.skillHub.unassignSkill(deviceId, skill.id);
              }
            }
          }
          deps.onAudit?.(
            session.username,
            "skillHubRemoveFromDevice",
            `${deviceId} · ${target.name.slice(0, 64)} · ${removed.removed ? "removed" : "missing"}`,
          );
          json(res, 200, { removed: removed.removed === true, deviceSkillId, snapshot });
          return true;
        }

        json(res, 404, { error: "not_found" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "skill hub request failed";
        if (err instanceof SkillHubOrderConflictError) {
          json(res, 409, { error: "skill_order_conflict", detail: message });
          return true;
        }
        if (isUnsupportedSyncError(err)) {
          json(res, 409, {
            error: "device_update_required",
            detail: "Update this device to manage skills remotely.",
          });
          return true;
        }
        const status = isTooLargeError(err)
          ? 413
          : /not found/i.test(message)
            ? 404
            : /unavailable|offline|timeout/i.test(message)
              ? 409
              : 400;
        json(res, status, { error: message });
      }
      return true;
    },
  };
}
