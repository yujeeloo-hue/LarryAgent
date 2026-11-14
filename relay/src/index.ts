/**
 * Entry point: HTTP (static console + health) and WS upgrade wiring.
 * TLS is terminated by Caddy in front; the process binds 127.0.0.1 only.
 */
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import { Hub, RELAY_VERSION } from "./hub.js";
import { AuthStore, createAuthEndpoints, clientIpOf, IPBanStore, verifySessionToken } from "./auth.js";
import { dataDirDefault, RelayStore } from "./store.js";
import { MemoryStore } from "./memory.js";
import { createMemoryEndpoints } from "./memoryEndpoints.js";
import { TokenHubStore } from "./tokenHubStore.js";
import { createTokenHubEndpoints } from "./tokenHubEndpoints.js";
import { McpHubStore } from "./mcpHubStore.js";
import { createMcpHubEndpoints } from "./mcpHubEndpoints.js";
import { SkillHubStore } from "./skillHubStore.js";
import { createSkillHubEndpoints } from "./skillHubEndpoints.js";
import { decryptEntry, encryptEntry } from "./memoryCipherNode.js";
import { MAX_WS_PAYLOAD_BYTES } from "./protocol.js";

export interface RelayHandle {
  server: Server;
  hub: Hub;
  store: RelayStore;
  memory: MemoryStore;
  tokenHub: TokenHubStore;
  mcpHub: McpHubStore;
  skillHub: SkillHubStore;
  authStore: AuthStore;
  banStore: IPBanStore;
  port: number;
  close(): Promise<void>;
}

export interface StartOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  publicDir?: string;
  /** URL path prefix the server is mounted under (e.g. "/relay"). Empty = root. */
  basePath?: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

function serveStatic(publicDir: string, pathname: string, res: import("node:http").ServerResponse): boolean {
  const root = resolve(publicDir);
  let target = normalize(join(root, pathname === "/" ? "index.html" : pathname));
  if (!target.startsWith(root + sep) && target !== root) return false;
  if (!existsSync(target)) {
    // SPA fallback for console routes.
    target = join(root, "index.html");
    if (!existsSync(target)) return false;
  }
  if (statSync(target).isDirectory()) target = join(target, "index.html");
  const body = readFileSync(target);
  res.writeHead(200, {
    "content-type": MIME[extname(target)] ?? "application/octet-stream",
    "cache-control": target.endsWith("index.html") ? "no-cache" : "public, max-age=300",
  });
  res.end(body);
  return true;
}

export async function startRelay(options: StartOptions = {}): Promise<RelayHandle> {
  const host = options.host ?? process.env.RELAY_HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.RELAY_PORT ?? 8788);
  const dataDir = options.dataDir ?? dataDirDefault();
  const publicDir = options.publicDir ?? process.env.RELAY_PUBLIC_DIR ?? join(process.cwd(), "public");
  const rawBase = options.basePath ?? process.env.RELAY_BASE_PATH ?? "";
  // Normalize: "" or "/" → ""; otherwise "/relay" (leading slash, no trailing).
  const basePath = rawBase === "/" || rawBase === "" ? "" : `/${rawBase.replace(/^\/+|\/+$/g, "")}`;
  // The process accepts BOTH the configured base path and the bare (root)
  // form, so larryagent.online/relay/* and remote.larryagent.online/* hit
  // the same deployment without a second instance.
  const stripBase = (pathname: string): string | null => {
    if (!basePath) return pathname;
    if (pathname === basePath) return "/";
    if (pathname.startsWith(basePath + "/")) return pathname.slice(basePath.length);
    // Bare form: "/" stays, "/api/…" passes through unchanged.
    return pathname.startsWith("/") ? pathname : null;
  };

  const store = new RelayStore(dataDir);
  const authStore = new AuthStore(dataDir);
  const banStore = new IPBanStore(dataDir);
  const memory = new MemoryStore(dataDir);
  const tokenHub = new TokenHubStore(dataDir);
  const mcpHub = new McpHubStore(dataDir);
  const skillHub = new SkillHubStore(dataDir);
  // Login attempts (ok / failed / throttled) land in the same audit log the
  // Manage view renders, IP included.
  const authEndpoints = createAuthEndpoints(authStore, banStore, (actor, action, detail) => {
    store.appendAudit({ ts: Date.now(), actor, action, detail });
  });
  const memoryEndpoints = createMemoryEndpoints({
    memory,
    keys: store,
    version: RELAY_VERSION,
    onAudit: (actor, action, detail) => {
      store.appendAudit({ ts: Date.now(), actor, action, detail });
    },
  });
  const hub = new Hub({
    store,
    // Key rotation re-encrypts every memory record in-process (design §4):
    // keys.json lives here, so the relay is the only place old+new meet.
    onKeyRotated: (keyId, oldKey, newKey) => {
      if (!memory.available) return;
      try {
        const stats = memory.reEncryptAll(
          oldKey,
          newKey,
          (docId, projectKey, env) => {
            try {
              return decryptEntry(oldKey, docId, projectKey, env);
            } catch {
              return null; // older key / corrupted — skip, never crash
            }
          },
          (docId, projectKey, plaintext) => encryptEntry(newKey, docId, projectKey, plaintext),
        );
        store.appendAudit({
          ts: Date.now(),
          actor: "relay",
          action: "memoryRekey",
          detail: `key ${keyId.slice(0, 8)} · re-encrypted ${stats.reEncrypted} · skipped ${stats.skipped}`,
        });
      } catch (err) {
        store.appendAudit({
          ts: Date.now(),
          actor: "relay",
          action: "memoryRekey",
          detail: `failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    },
  });
  const tokenHubEndpoints = createTokenHubEndpoints({
    tokenHub,
    isDeviceOnline: (deviceId) => hub.isDeviceOnline(deviceId),
    callDevice: (deviceId, action, payload) => hub.callDevice(deviceId, action, payload),
    onAudit: (actor, action, detail) => {
      store.appendAudit({ ts: Date.now(), actor, action, detail });
    },
  });
  const mcpHubEndpoints = createMcpHubEndpoints({
    mcpHub,
    isDeviceOnline: (deviceId) => hub.isDeviceOnline(deviceId),
    callDevice: (deviceId, action, payload) => hub.callDevice(deviceId, action, payload),
    onAudit: (actor, action, detail) => {
      store.appendAudit({ ts: Date.now(), actor, action, detail });
    },
  });
  const skillHubEndpoints = createSkillHubEndpoints({
    skillHub,
    isDeviceOnline: (deviceId) => hub.isDeviceOnline(deviceId),
    callDevice: (deviceId, action, payload) => hub.callDevice(deviceId, action, payload),
    onAudit: (actor, action, detail) => {
      store.appendAudit({ ts: Date.now(), actor, action, detail });
    },
  });
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const pathname = stripBase(decodeURIComponent(url.pathname));
      if (pathname === null) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      // Banned IPs are refused site-wide (static console included).
      const clientIp = clientIpOf(req);
      if (banStore.isBanned(clientIp)) {
        banStore.noteRejected(clientIp, pathname);
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "ip_banned" }));
        return;
      }
      if (await authEndpoints.handle(pathname, req, res)) return;
      if (await memoryEndpoints.handle(pathname, req, res)) return;
      if (await tokenHubEndpoints.handle(pathname, req, res)) return;
      if (await mcpHubEndpoints.handle(pathname, req, res)) return;
      if (await skillHubEndpoints.handle(pathname, req, res)) return;
      if (pathname === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, version: RELAY_VERSION }));
        return;
      }
      if (req.method === "GET" && serveStatic(publicDir, pathname, res)) return;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    })().catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    });
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD_BYTES });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const stripped = stripBase(url.pathname);
    if (stripped === "/ws/device" || stripped === "/ws/viewer") {
      const clientIp = clientIpOf(req);
      if (banStore.isBanned(clientIp)) {
        banStore.noteRejected(clientIp, `ws ${stripped}`);
        socket.destroy();
        return;
      }
      console.log(`[jellybot-relay] ws connect path=${stripped} ip=${clientIp}`);
      // Hub.attach matches the raw path (/ws/device|/ws/viewer) — rewrite the
      // prefix-stripped route back onto req.url before handing it over.
      req.url = stripped + url.search;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });
  hub.attach(wss);

  await new Promise<void>((resolvePromise) => server.listen(port, host, resolvePromise));
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;

  return {
    server,
    hub,
    store,
    memory,
    tokenHub,
    mcpHub,
    skillHub,
    authStore,
    banStore,
    port: actualPort,
    close: async () => {
      hub.dispose();
      wss.close();
      memory.close();
      tokenHub.close();
      mcpHub.close();
      skillHub.close();
      // Force-close any lingering socket so close() never dangles on a
      // half-open client during tests or shutdown.
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

export function main(): void {
  startRelay()
    .then((relay) => {
      console.log(`[jellybot-relay] v${RELAY_VERSION} listening on 127.0.0.1:${relay.port}`);
      console.log(`[jellybot-relay] data dir: ${relay.store.dataDir}`);
      console.log(`[jellybot-relay] web console login: ${relay.authStore.username} (auth.json)`);
      console.log(
        relay.memory.available
          ? `[jellybot-relay] memory sync: enabled (${relay.memory.memoryDbPath})`
          : `[jellybot-relay] memory sync: DISABLED — ${relay.memory.unavailableReason}`,
      );
      console.log(
        relay.tokenHub.available
          ? `[jellybot-relay] token hub: encrypted (${relay.tokenHub.dbPath})`
          : `[jellybot-relay] token hub: DISABLED — ${relay.tokenHub.unavailableReason}`,
      );
      console.log(
        relay.mcpHub.available
          ? `[jellybot-relay] mcp hub: encrypted (${relay.mcpHub.dbPath})`
          : `[jellybot-relay] mcp hub: DISABLED — ${relay.mcpHub.unavailableReason}`,
      );
      console.log(
        relay.skillHub.available
          ? `[jellybot-relay] skill hub: encrypted (${relay.skillHub.dbPath})`
          : `[jellybot-relay] skill hub: DISABLED — ${relay.skillHub.unavailableReason}`,
      );
      for (const k of relay.store.keySummaries()) {
        console.log(`[jellybot-relay] key "${k.name}" ••••${k.keyTail} (${k.deviceCount} devices)`);
      }
    })
    .catch((err) => {
      console.error("[jellybot-relay] fatal:", err);
      process.exit(1);
    });
}

// Run as script only (tests import startRelay directly).
if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")) {
  main();
}
