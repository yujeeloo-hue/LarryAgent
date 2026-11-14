/**
 * HTTP endpoints for memory sync (design §6).
 *
 * Device family — Bearer API key (same jbr_ keys as the WS bridge):
 *   GET  /api/memory/status           (anonymous → minimal probe payload;
 *                                      authorized → full store status)
 *   POST /api/memory/history:push     {rows, deviceId?}
 *   POST /api/memory/docs:push-entries {projectKey, docId, entries, tombstones, deviceId?}
 *   POST /api/memory/pull             {since, limit, deviceId?}
 *
 * Console family — session token (X-Auth-Token, same as /api/auth/security):
 *   GET  /api/console/memory/overview  (M4a)
 *
 * Every push/pull writes an audit entry (actor = key name + deviceId).
 * The relay never decrypts anything on these paths — ciphertext is stored
 * and forwarded opaque (encryption happens client-side; see memoryCipher*).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { MemoryStore } from "./memory.js";
import { isMemoryDocId } from "./memoryCipherCore.js";
import { verifySessionToken } from "./auth.js";
import { clientIpOf } from "./auth.js";

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Subset of RelayStore the endpoints need (keeps this module testable). */
export interface MemoryKeyStore {
  checkKey(candidate: string): { id: string; name: string } | null;
  isBlocked(deviceId: string): boolean;
}

export interface MemoryEndpointsDeps {
  memory: MemoryStore;
  keys: MemoryKeyStore;
  version: string;
  onAudit?: (actor: string, action: string, detail?: string) => void;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
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

function bearerKey(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (typeof header !== "string") return "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1]!.trim() : "";
}

export function createMemoryEndpoints(deps: MemoryEndpointsDeps): {
  handle(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
} {
  const { memory, keys, version } = deps;

  /** Auth + device-block check; returns the actor label or null (responded). */
  const authDevice = (req: IncomingMessage, res: ServerResponse, bodyDeviceId: unknown): string | null => {
    const keyRecord = keys.checkKey(bearerKey(req));
    if (!keyRecord) {
      json(res, 401, { error: "invalid_api_key" });
      return null;
    }
    const deviceId = typeof bodyDeviceId === "string" ? bodyDeviceId : "";
    if (deviceId && keys.isBlocked(deviceId)) {
      json(res, 403, { error: "device_blocked" });
      return null;
    }
    return deviceId ? `${keyRecord.name}/${deviceId}` : keyRecord.name;
  };

  const requireSession = (req: IncomingMessage, res: ServerResponse): string | null => {
    const session = verifySessionToken(req.headers["x-auth-token"]);
    if (!session) {
      json(res, 401, { error: "invalid_session" });
      return null;
    }
    return session.username;
  };

  return {
    async handle(pathname, req, res) {
      if (!pathname.startsWith("/api/memory/") && !pathname.startsWith("/api/console/memory/")) return false;

      if (req.method === "GET" && pathname === "/api/memory/status") {
        const presented = bearerKey(req);
        const keyRecord = presented ? keys.checkKey(presented) : null;
        if (presented && !keyRecord) {
          // A client that presents a key deserves to learn it is wrong;
          // only key-less probes get the anonymous payload.
          json(res, 401, { error: "invalid_api_key" });
          return true;
        }
        if (keyRecord) {
          json(res, 200, { version, ...memory.status() });
        } else {
          // Anonymous probe (deploy verification): counts only, no devices.
          const s = memory.status();
          json(res, 200, { version, sqlite: s.sqlite, reason: s.reason ?? null });
        }
        return true;
      }

      if (!memory.available) {
        json(res, 503, { error: "memory_unavailable", reason: memory.unavailableReason });
        return true;
      }

      if (req.method === "POST" && pathname === "/api/memory/history:push") {
        const body = await readJsonBody(req);
        const actor = authDevice(req, res, body.deviceId);
        if (!actor) return true;
        try {
          const { results } = memory.pushHistory(body.rows, typeof body.deviceId === "string" ? body.deviceId : actor);
          const accepted = results.filter((r) => r.status === "accepted").length;
          deps.onAudit?.(actor, "memoryPush", `history ${results.length} rows · ${accepted} accepted`);
          if (typeof body.deviceId === "string") memory.notePush(body.deviceId);
          json(res, 200, { results });
        } catch (err) {
          json(res, 400, { error: "bad_request", message: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }

      if (req.method === "POST" && pathname === "/api/memory/docs:push-entries") {
        const body = await readJsonBody(req);
        const actor = authDevice(req, res, body.deviceId);
        if (!actor) return true;
        const projectKey = typeof body.projectKey === "string" ? body.projectKey : "";
        if (!projectKey || !isMemoryDocId(body.docId)) {
          json(res, 400, { error: "bad_request", message: "projectKey and docId (worklog|pitfalls|style) required" });
          return true;
        }
        try {
          const result = memory.pushDocEntries(projectKey, body.docId, body.entries ?? [], body.tombstones ?? [], typeof body.deviceId === "string" ? body.deviceId : actor);
          deps.onAudit?.(
            actor,
            "memoryPush",
            `docs ${body.docId} +${result.accepted} · revive ${result.revived} · tomb ${result.tombstoned} · cap ${result.capped}`,
          );
          if (typeof body.deviceId === "string") memory.notePush(body.deviceId);
          json(res, 200, { result });
        } catch (err) {
          json(res, 400, { error: "bad_request", message: err instanceof Error ? err.message : String(err) });
        }
        return true;
      }

      if (req.method === "POST" && pathname === "/api/memory/pull") {
        const body = await readJsonBody(req, 16 * 1024);
        const actor = authDevice(req, res, body.deviceId);
        if (!actor) return true;
        const since = typeof body.since === "number" && Number.isFinite(body.since) && body.since >= 0 ? Math.floor(body.since) : 0;
        const limit = typeof body.limit === "number" && Number.isFinite(body.limit) ? body.limit : 200;
        const result = memory.pull(since, limit);
        const ip = clientIpOf(req);
        if (typeof body.deviceId === "string" && body.deviceId) {
          memory.noteDevice(body.deviceId, null, ip, typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined);
          memory.notePull(body.deviceId, result.nextSince);
        }
        deps.onAudit?.(actor, "memoryPull", `since ${since} → ${result.nextSince} · ${result.changes.length} changes`);
        json(res, 200, result);
        return true;
      }

      if (req.method === "GET" && pathname === "/api/console/memory/overview") {
        const actor = requireSession(req, res);
        if (!actor) return true;
        json(res, 200, { version, ...memory.status(), projects: memory.listProjects() });
        return true;
      }

      json(res, 404, { error: "not found" });
      return true;
    },
  };
}
