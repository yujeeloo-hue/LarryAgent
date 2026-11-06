/**
 * Regression: WS endpoints must work under RELAY_BASE_PATH (e.g. /relay).
 * Catches the "hub matches raw req.url" trap — see index.ts upgrade handler.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRelay } from "../src/index.ts";
import WebSocket from "ws";

function wsAuth(url: string, apiKey: string, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timeout waiting for authOk on ${url}`));
    }, timeoutMs);
    ws.on("open", () => ws.send(JSON.stringify({ type: "auth", apiKey })));
    ws.on("message", (raw: unknown) => {
      const msg = JSON.parse(String(raw)) as { type?: string };
      if (msg.type === "authOk") {
        clearTimeout(timer);
        ws.close();
        resolve("authOk");
      } else if (msg.type === "authFailed") {
        clearTimeout(timer);
        ws.close();
        reject(new Error("authFailed"));
      }
    });
    ws.on("error", (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe("relay basePath", () => {
  it("serves WS viewer auth under /relay prefix", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "relay-base-test-"));
    const relay = await startRelay({ port: 0, dataDir, basePath: "/relay" });
    try {
      const apiKey = (
        JSON.parse(readFileSync(join(dataDir, "keys.json"), "utf8")) as { keys: { key: string }[] }
      ).keys[0]!.key;
      const result = await wsAuth(`ws://127.0.0.1:${relay.port}/relay/ws/viewer`, apiKey);
      assert.equal(result, "authOk");
    } finally {
      await relay.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("serves WS viewer auth on the bare path too (subdomain form)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "relay-base-test-"));
    const relay = await startRelay({ port: 0, dataDir, basePath: "/relay" });
    try {
      const apiKey = (
        JSON.parse(readFileSync(join(dataDir, "keys.json"), "utf8")) as { keys: { key: string }[] }
      ).keys[0]!.key;
      // remote.larryagent.online/* proxies the bare form to the same process.
      const result = await wsAuth(`ws://127.0.0.1:${relay.port}/ws/viewer`, apiKey);
      assert.equal(result, "authOk");
    } finally {
      await relay.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("answers HTTP on both the prefixed and bare forms", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "relay-base-test-"));
    const relay = await startRelay({ port: 0, dataDir, basePath: "/relay", publicDir: "public" });
    try {
      const codes = await Promise.all(
        ["/relay/api/health", "/api/health", "/relay/", "/"].map(async (path) => {
          const res = await fetch(`http://127.0.0.1:${relay.port}${path}`);
          return [path, res.status] as const;
        }),
      );
      for (const [path, status] of codes) assert.equal(status, 200, `${path} should serve`);
    } finally {
      await relay.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
