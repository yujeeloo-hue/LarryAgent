/**
 * Web console auth: captcha login → session token → WS viewer auth.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startRelay, type RelayHandle } from "../src/index.ts";
import {
  captchaAnswerFor,
  clearSessionsForTests,
  createCaptcha,
  verifyCaptcha,
} from "../src/auth.ts";

let relay: RelayHandle;
let dataDir: string;
let base: string;

const ADMIN_USER = "ops";
const ADMIN_PASSWORD = "hunter2-secret";

function nextMsg<T>(ws: WebSocket, predicate: (msg: T) => boolean, timeoutMs = 3000): Promise<T> {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      rejectP(new Error("timeout waiting for message"));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw)) as T;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolveP(msg);
      }
    };
    ws.on("message", onMessage);
  });
}

function httpJson(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolveP, rejectP) => {
    const req = fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    req.then(async (res) => {
      resolveP({ status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> });
    }, rejectP);
  });
}

describe("relay web auth", () => {
  beforeEach(async () => {
    clearSessionsForTests();
    dataDir = mkdtempSync(join(tmpdir(), "relay-auth-test-"));
    process.env.RELAY_ADMIN_USER = ADMIN_USER;
    process.env.RELAY_ADMIN_PASSWORD = ADMIN_PASSWORD;
    process.env.RELAY_DISABLE_CAPTCHA = "true";
    relay = await startRelay({ port: 0, dataDir });
    base = `http://127.0.0.1:${relay.port}`;
  });

  afterEach(async () => {
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.RELAY_ADMIN_USER;
    delete process.env.RELAY_ADMIN_PASSWORD;
    delete process.env.RELAY_DISABLE_CAPTCHA;
  });

  it("requires a captcha on every login when not disabled", async () => {
    // beforeEach starts the relay with the disable flag on — restart without
    // it to exercise the always-on captcha gate.
    await relay.close();
    delete process.env.RELAY_DISABLE_CAPTCHA;
    relay = await startRelay({ port: 0, dataDir });
    base = `http://127.0.0.1:${relay.port}`;

    // Missing/wrong captcha → rejected before credentials are even checked.
    const noCaptcha = await httpJson("POST", "/api/auth/login", {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    });
    assert.equal(noCaptcha.status, 401);
    assert.equal(noCaptcha.json.error, "invalid_captcha");

    const challenge = createCaptcha();
    const wrong = await httpJson("POST", "/api/auth/login", {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
      captchaId: challenge.id,
      captchaAnswer: "zzzz",
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json.error, "invalid_captcha");

    // Right captcha + credentials → session token.
    const good = createCaptcha();
    const ok = await httpJson("POST", "/api/auth/login", {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
      captchaId: good.id,
      captchaAnswer: captchaAnswerFor(good.id),
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
  });

  it("issues and single-uses captchas", () => {    // verifyCaptcha short-circuits under the disabled flag — run raw.
    const saved = process.env.RELAY_DISABLE_CAPTCHA;
    delete process.env.RELAY_DISABLE_CAPTCHA;
    try {
      const c1 = createCaptcha();
      assert.match(c1.svg, /^<svg/);
      const answer = captchaAnswerFor(c1.id);
      assert.ok(answer && answer.length === 4);
      // Same challenge cannot be consumed twice.
      assert.equal(verifyCaptcha(c1.id, answer), true);
      assert.equal(verifyCaptcha(c1.id, answer), false);
      // Wrong answer also consumes.
      const c2 = createCaptcha();
      assert.equal(verifyCaptcha(c2.id, "zzzz"), false);
      assert.equal(verifyCaptcha(c2.id, captchaAnswerFor(c2.id)), false);
    } finally {
      if (saved !== undefined) process.env.RELAY_DISABLE_CAPTCHA = saved;
    }
  });

  it("logs in with username + password and returns a session token", async () => {
    const ok = await httpJson("POST", "/api/auth/login", {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.username, ADMIN_USER);
    assert.ok(typeof ok.json.token === "string" && ok.json.token.length > 10);
  });

  it("rejects bad credentials and locks out after repeated failures", async () => {
    for (let i = 0; i < 5; i++) {
      const bad = await httpJson("POST", "/api/auth/login", { username: ADMIN_USER, password: "nope" });
      assert.equal(bad.status, 401);
      assert.equal(bad.json.error, "invalid_credentials");
    }
    const blocked = await httpJson("POST", "/api/auth/login", {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.json.error, "too_many_attempts");
  });

  it("audits login attempts with the client IP", async () => {
    // Successful attempt → loginOk with the caller's IP.
    const spoofed = "203.0.113.77";
    const ok = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": spoofed },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
    });
    assert.equal(ok.status, 200);
    let audit = relay.store.recentAudit(50);
    const okEntry = audit.find((e) => e.action === "loginOk");
    assert.ok(okEntry, "loginOk audit entry exists");
    assert.equal(okEntry.actor, ADMIN_USER);
    assert.match(okEntry.detail ?? "", new RegExp(`ip=${spoofed}`));

    // Failed attempt → loginFailed with attempted user + IP + reason.
    const fail = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": spoofed },
      body: JSON.stringify({ username: "root", password: "wrong" }),
    });
    assert.equal(fail.status, 401);
    audit = relay.store.recentAudit(50);
    const failEntry = audit.find((e) => e.action === "loginFailed");
    assert.ok(failEntry, "loginFailed audit entry exists");
    assert.equal(failEntry.actor, "root");
    assert.match(failEntry.detail ?? "", new RegExp(`ip=${spoofed} · invalid_credentials`));

    // Watchdog: a failing WS viewer auth carries the IP too.
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws/viewer`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "auth", apiKey: "jbr_wrong" }));
    await new Promise<void>((r) => ws.once("close", () => r()));
    audit = relay.store.recentAudit(50);
    const wsEntry = audit.find((e) => e.action === "authFailed");
    assert.ok(wsEntry, "viewer authFailed audit entry exists");
    assert.match(wsEntry.detail ?? "", /ip=/);
  });

  it("audits the lockout when repeated failures cross the threshold", async () => {
    const spoofed = "198.51.100.99";
    for (let i = 0; i < 5; i++) {
      const bad = await fetch(`${base}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": spoofed },
        body: JSON.stringify({ username: ADMIN_USER, password: "nope" }),
      });
      assert.equal(bad.status, 401);
    }
    const audit = relay.store.recentAudit(50);
    const locked = audit.find((e) => e.action === "loginLocked");
    assert.ok(locked, "loginLocked audit entry exists");
    assert.match(locked.detail ?? "", new RegExp(`ip=${spoofed}`));
    // Exactly one lockout note per window — not one per failure.
    assert.equal(audit.filter((e) => e.action === "loginLocked").length, 1);
    // Five per-attempt failure rows accompany it.
    assert.equal(audit.filter((e) => e.action === "loginFailed").length, 5);
  });

  it("authenticates a WS viewer with the session token", async () => {
    const login = await httpJson("POST", "/api/auth/login", {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    });
    assert.equal(login.status, 200);
    const token = String(login.json.token);

    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/ws/viewer`);
    await new Promise<void>((r) => ws.once("open", () => r()));
    ws.send(JSON.stringify({ type: "auth", sessionToken: token }));
    const okMsg = await nextMsg<{ type: string; keyName?: string; keyId?: string }>(ws, (m) => m.type === "authOk");
    assert.equal(okMsg.keyName, ADMIN_USER);
    assert.equal(okMsg.keyId, "");
    ws.close();
  });

  it("changes the password and invalidates the old one", async () => {
    const login = await httpJson("POST", "/api/auth/login", {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    });
    const token = String(login.json.token);
    const change = await httpJson("POST", "/api/auth/password", {
      token,
      currentPassword: ADMIN_PASSWORD,
      password: "new-pass-99",
    });
    assert.equal(change.status, 200);

    const oldLogin = await httpJson("POST", "/api/auth/login", {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    });
    assert.equal(oldLogin.status, 401);
    const newLogin = await httpJson("POST", "/api/auth/login", {
      username: ADMIN_USER,
      password: "new-pass-99",
    });
    assert.equal(newLogin.status, 200);
  });
});

describe("ip banning", () => {
  let token: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-ban-test-"));
    process.env.RELAY_ADMIN_USER = ADMIN_USER;
    process.env.RELAY_ADMIN_PASSWORD = ADMIN_PASSWORD;
    process.env.RELAY_DISABLE_CAPTCHA = "true";
    relay = await startRelay({ port: 0, dataDir });
    base = `http://127.0.0.1:${relay.port}`;
    const login = await httpJson("POST", "/api/auth/login", {
      username: ADMIN_USER,
      password: ADMIN_PASSWORD,
    });
    token = String(login.json.token);
  });

  afterEach(async () => {
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.RELAY_ADMIN_USER;
    delete process.env.RELAY_ADMIN_PASSWORD;
    delete process.env.RELAY_DISABLE_CAPTCHA;
  });

  it("clientIpOf trusts the last X-Forwarded-For hop only", async () => {
    const { clientIpOf } = await import("../src/auth.ts");
    const mk = (headers: Record<string, string>, remote = "203.0.113.9") =>
      ({ headers, socket: { remoteAddress: remote } }) as never;
    // Forged entries sort before the proxy-appended one.
    assert.equal(clientIpOf(mk({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" })), "2.2.2.2");
    assert.equal(clientIpOf(mk({ "x-forwarded-for": "9.9.9.9" })), "9.9.9.9");
    assert.equal(clientIpOf(mk({}, "10.0.0.5")), "10.0.0.5");
  });

  it("manual ban refuses the IP site-wide until unbanned", async () => {
    const ban = await fetch(`${base}/api/auth/ban`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-token": token },
      body: JSON.stringify({ ip: "198.51.100.7" }),
    });
    assert.equal(ban.status, 200);

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
    });
    assert.equal(login.status, 403);
    assert.equal((await login.json()).error, "ip_banned");

    // Static console + health are refused too.
    const page = await fetch(`${base}/`, { headers: { "x-forwarded-for": "198.51.100.7" } });
    assert.equal(page.status, 403);
    const health = await fetch(`${base}/api/health`, { headers: { "x-forwarded-for": "198.51.100.7" } });
    assert.equal(health.status, 403);

    // Unban restores access; the listing reflects both states.
    const unban = await fetch(`${base}/api/auth/unban`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-token": token },
      body: JSON.stringify({ ip: "198.51.100.7" }),
    });
    assert.equal(unban.status, 200);
    const ok = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
    });
    assert.equal(ok.status, 200);
  });

  it("security endpoints require a session token and a valid ip", async () => {
    const anon = await fetch(`${base}/api/auth/security`);
    assert.equal(anon.status, 401);
    const badBan = await fetch(`${base}/api/auth/ban`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-auth-token": token },
      body: JSON.stringify({ ip: "not-an-ip" }),
    });
    assert.equal(badBan.status, 400);

    const sec = await fetch(`${base}/api/auth/security`, { headers: { "x-auth-token": token } });
    assert.equal(sec.status, 200);
    const data = (await sec.json()) as { bans: unknown[]; failures: unknown[]; autoBanStrikes: number };
    assert.ok(Array.isArray(data.bans));
    assert.ok(Array.isArray(data.failures));
    assert.equal(data.autoBanStrikes, 3);
  });

  it("repeated lockouts escalate to a persisted auto ban", async () => {
    const ip = "192.0.2.44";
    // Simulate three lockout windows (the blocked state would stop real
    // requests, so the limiter is driven directly).
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 5; i++) relay.banStore.recordFailure(ip);
    }
    assert.ok(relay.banStore.isBanned(ip));
    // Auto bans carry an expiry (never permanent)…
    const rec = relay.banStore.isBanned(ip)!;
    assert.ok(rec.expiresAt > Date.now());
    assert.match(rec.reason, /auto/);
    // …and persist across restarts.
    await relay.close();
    relay = await startRelay({ port: 0, dataDir });
    assert.ok(relay.banStore.isBanned(ip));
  });
});
