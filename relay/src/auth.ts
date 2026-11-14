/**
 * Web console authentication — username + password login gated by an SVG
 * captcha, mirroring the JNote Web flow. Console browsers authenticate with
 * the in-memory session token issued by /api/auth/login; devices (and API
 * tooling) keep using API keys directly over WS.
 *
 * Credential lives in <dataDir>/auth.json as {username, salt, hash} with a
 * scrypt hash. First boot seeds it from RELAY_ADMIN_USER / RELAY_ADMIN_PASSWORD
 * or falls back to admin + a random password printed once to the log.
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── captcha ────────────────────────────────────────────────────
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const CAPTCHA_MAX_LIVE = 10_000;
const ALPHABET = "37acdefhjkmnprtuvwxy";
const CODE_LENGTH = 4;

interface Challenge {
  answer: string;
  expiresAt: number;
}

const challenges = new Map<string, Challenge>();

let sweeper: ReturnType<typeof setInterval> | null = null;
function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt < now) challenges.delete(id);
    }
  }, 60_000);
  sweeper.unref?.();
}

const PALETTE = ["#e8ecf4", "#c9d4e8", "#9fb3d4", "#7d94bb", "#d4dbe8"];
const WIDTH = 132;
const HEIGHT = 44;

function renderSvg(code: string): string {
  const r = Math.random;
  const jitter = (range: number) => (r() - 0.5) * range;
  const cell = WIDTH / (CODE_LENGTH + 0.4);
  const chars = [...code]
    .map((char, index) => {
      const x = cell * (index + 0.7) + jitter(6);
      const y = HEIGHT / 2 + jitter(4);
      const rotation = jitter(34);
      const size = 22 + r() * 6;
      const fill = PALETTE[Math.floor(r() * PALETTE.length)]!;
      return (
        `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" ` +
        `transform="rotate(${rotation.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})" ` +
        `font-family="Georgia, 'Times New Roman', serif" font-size="${size.toFixed(1)}" ` +
        `font-style="${r() > 0.5 ? "italic" : "normal"}" ` +
        `fill="${fill}" text-anchor="middle" dominant-baseline="central">${char}</text>`
      );
    })
    .join("");

  const waves = [0.35, 0.65]
    .map((ratio) => {
      const y = HEIGHT * ratio + jitter(5);
      const amplitude = 3 + r() * 4;
      const points: string[] = [];
      for (let x = 0; x <= WIDTH; x += WIDTH / 8) {
        points.push(`${x.toFixed(1)},${(y + Math.sin(x / 9 + r() * 6) * amplitude).toFixed(1)}`);
      }
      const stroke = PALETTE[Math.floor(r() * PALETTE.length)]!;
      return `<polyline points="${points.join(" ")}" fill="none" stroke="${stroke}" ` +
        `stroke-width="1.4" stroke-opacity="0.7" stroke-linecap="round"/>`;
    })
    .join("");

  const dots = Array.from({ length: 26 }, () => {
    const x = (r() * WIDTH).toFixed(1);
    const y = (r() * HEIGHT).toFixed(1);
    const radius = (0.6 + r() * 1.2).toFixed(1);
    const fill = PALETTE[Math.floor(r() * PALETTE.length)]!;
    return `<circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}" fill-opacity="0.45"/>`;
  }).join("");

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" ` +
    `viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="captcha">` +
    `<rect width="${WIDTH}" height="${HEIGHT}" rx="6" fill="#12151c"/>` + dots + chars + waves + `</svg>`
  );
}

export function createCaptcha(): { id: string; svg: string } {
  ensureSweeper();
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]!;
  while (challenges.size >= CAPTCHA_MAX_LIVE) {
    challenges.delete(challenges.keys().next().value!);
  }
  const id = randomUUID();
  challenges.set(id, { answer: code, expiresAt: Date.now() + CAPTCHA_TTL_MS });
  return { id, svg: renderSvg(code) };
}

/** Single-use check: correct + unexpired + not consumed before. */
export function verifyCaptcha(id: unknown, answer: unknown): boolean {
  if (process.env.RELAY_DISABLE_CAPTCHA === "true") return true;
  if (typeof id !== "string" || typeof answer !== "string") return false;
  const challenge = challenges.get(id);
  if (!challenge) return false;
  challenges.delete(id);
  if (challenge.expiresAt < Date.now()) return false;
  return answer.trim().toLowerCase() === challenge.answer;
}

/** Test hook: reveal a live challenge's answer for in-process login tests. */
export function captchaAnswerFor(id: string): string | null {
  return challenges.get(id)?.answer ?? null;
}

// ── password credential ────────────────────────────────────────
const SCRYPT_N = 16384;
const SCRYPT_KEYLEN = 64;

export interface Credential {
  username: string;
  salt: string; // base64
  hash: string; // base64
}

function hashPassword(password: string, saltB64: string): string {
  return scryptSync(password.normalize("NFKC"), Buffer.from(saltB64, "base64"), SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: 8,
    p: 1,
  }).toString("base64");
}

function safeEqualB64(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "base64");
  const bufB = Buffer.from(b, "base64");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

const PASSWORD_WORDS = "amber basil cedar delta ember flint grove harbor ivory juniper kelp lunar moss nimbus opal pine quill ridge slate tundra umber vega willow yarrow".split(" ");

function randomPassword(): string {
  const bytes = randomBytes(4);
  const word = PASSWORD_WORDS[bytes[0]! % PASSWORD_WORDS.length]!;
  return `${word}-${randomBytes(3).toString("hex")}`;
}

export class AuthStore {
  private cred: Credential;
  readonly authFile: string;

  constructor(dataDir: string) {
    this.authFile = join(dataDir, "auth.json");
    if (existsSync(this.authFile)) {
      const parsed = JSON.parse(readFileSync(this.authFile, "utf8")) as Partial<Credential>;
      if (typeof parsed.username === "string" && typeof parsed.salt === "string" && typeof parsed.hash === "string") {
        this.cred = { username: parsed.username, salt: parsed.salt, hash: parsed.hash };
        return;
      }
    }
    const username = process.env.RELAY_ADMIN_USER?.trim() || "admin";
    const password = process.env.RELAY_ADMIN_PASSWORD || randomPassword();
    const salt = randomBytes(16).toString("base64");
    this.cred = { username, salt, hash: hashPassword(password, salt) };
    writeFileSync(this.authFile, JSON.stringify(this.cred, null, 2) + "\n", { mode: 0o600 });
    if (!process.env.RELAY_ADMIN_PASSWORD) {
      // Seeded randomly — surface it once so the operator can actually sign in.
      console.log(`[jellybot-relay] web console login: ${username} / ${password} (auth.json)`);
    }
  }

  get username(): string {
    return this.cred.username;
  }

  verify(username: unknown, password: unknown): boolean {
    if (typeof username !== "string" || typeof password !== "string") return false;
    if (username !== this.cred.username) return false;
    return safeEqualB64(hashPassword(password, this.cred.salt), this.cred.hash);
  }

  /** Change username and/or password after verifying the current password. */
  update(currentPassword: string, next: { username?: string; password?: string }): boolean {
    if (!this.verify(this.cred.username, currentPassword)) return false;
    if (next.username?.trim()) this.cred.username = next.username.trim();
    if (next.password) {
      const salt = randomBytes(16).toString("base64");
      this.cred.salt = salt;
      this.cred.hash = hashPassword(next.password, salt);
    }
    writeFileSync(this.authFile, JSON.stringify(this.cred, null, 2) + "\n", { mode: 0o600 });
    return true;
  }
}

// ── sessions (in-memory tokens for WS auth) ─────────────────────
export interface SessionRecord {
  username: string;
  expiresAt: number;
}

const SESSION_TTL_MS = 7 * 24 * 3600_000;
const sessions = new Map<string, SessionRecord>();

export function createSessionToken(username: string): { token: string; expiresAt: number } {
  const token = randomBytes(24).toString("base64url");
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { username, expiresAt });
  if (sessions.size > 1000) {
    const now = Date.now();
    for (const [t, rec] of sessions) if (rec.expiresAt < now) sessions.delete(t);
  }
  return { token, expiresAt };
}

export function verifySessionToken(token: unknown): SessionRecord | null {
  if (typeof token !== "string" || token.length === 0) return null;
  const rec = sessions.get(token);
  if (!rec) return null;
  if (rec.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return rec;
}

export function destroySessionToken(token: unknown): void {
  if (typeof token === "string") sessions.delete(token);
}

/** Test/dev hook: clear all sessions. */
export function clearSessionsForTests(): void {
  sessions.clear();
}

// ── IP security: client IP resolution + rate limiting + persistent bans ──
const RATE_WINDOW_MS = 15 * 60_000;
const RATE_MAX_FAILURES = 5;
const RATE_BLOCK_MS = 15 * 60_000;
/** Rate-limit lockouts before an IP graduates to a persistent auto-ban. */
const AUTO_BAN_STRIKES = 3;
/** Auto bans always expire — a mistyped owner self-heals next day. */
const AUTO_BAN_TTL_MS = 24 * 3600_000;

export interface BanRecord {
  ip: string;
  reason: string;
  bannedAt: number;
  /** 0 = permanent (manual bans only). */
  expiresAt: number;
}

export interface FailureSnapshot {
  ip: string;
  failures: number;
  strikes: number;
  blockedUntil: number;
}

/** Plain IPv4 / IPv6 literal check (no CIDR, no port). */
export function isValidIp(ip: unknown): ip is string {
  if (typeof ip !== "string" || ip.length === 0 || ip.length > 45) return false;
  if (ip.includes(":")) return /^[0-9a-fA-F:.]+$/.test(ip);
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(ip)
    && ip.split(".").every((octet) => Number(octet) <= 255);
}

/**
 * Client IP behind the Caddy reverse proxy. X-Forwarded-For's LAST entry is
 * the hop Caddy appended — client-supplied entries sort before it and are
 * forgeable, so earlier hops are never trusted. Direct connections fall
 * back to the socket address.
 */
export function clientIpOf(req: import("node:http").IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") {
    const last = xff.split(",").map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Keep attacker-controlled strings out of single-line log records. */
function logSafe(value: unknown): string {
  return String(value ?? "").replace(/[\r\n"']/g, "").slice(0, 48);
}

interface PersistedBans {
  version: 1;
  bans: BanRecord[];
  strikes: Record<string, number>;
}

/**
 * Persistent IP ban list + the per-IP rate limiter that feeds it. Bans live
 * in <dataDir>/ipban.json so they survive restarts; the limiter is in-memory
 * (JNote Web semantics). Repeated lockouts escalate into an expiring auto
 * ban so a credential stuffer gets cut off for a day without any operator
 * action.
 */
export class IPBanStore {
  private bans = new Map<string, BanRecord>();
  private strikes = new Map<string, number>();
  private failures = new Map<FailureSnapshot["ip"], { failures: number; windowStart: number; blockedUntil: number }>();
  private lastRejectLog = new Map<string, number>();
  readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "ipban.json");
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<PersistedBans>;
        for (const rec of parsed.bans ?? []) {
          if (isValidIp(rec.ip) && typeof rec.reason === "string") {
            this.bans.set(rec.ip, { ip: rec.ip, reason: rec.reason, bannedAt: rec.bannedAt ?? Date.now(), expiresAt: rec.expiresAt ?? 0 });
          }
        }
        for (const [ip, count] of Object.entries(parsed.strikes ?? {})) {
          if (isValidIp(ip) && typeof count === "number") this.strikes.set(ip, count);
        }
      } catch {
        /* corrupt file — start clean rather than refusing to boot */
      }
    }
  }

  private persist(): void {
    const payload: PersistedBans = {
      version: 1,
      bans: [...this.bans.values()],
      strikes: Object.fromEntries(this.strikes),
    };
    writeFileSync(this.file, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  }

  isBanned(ip: string): BanRecord | null {
    const rec = this.bans.get(ip);
    if (!rec) return null;
    if (rec.expiresAt > 0 && rec.expiresAt < Date.now()) {
      this.bans.delete(ip);
      this.strikes.delete(ip);
      this.persist();
      return null;
    }
    return rec;
  }

  ban(ip: string, reason: string, ttlMs = 0): void {
    this.bans.set(ip, { ip, reason, bannedAt: Date.now(), expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0 });
    this.failures.delete(ip);
    this.persist();
    const until = ttlMs > 0 ? ` expires=${Math.round(ttlMs / 3600_000)}h` : " permanent";
    console.log(`[jellybot-relay] ban add ip=${ip} reason="${logSafe(reason)}"${until}`);
  }

  unban(ip: string): boolean {
    const had = this.bans.delete(ip);
    this.strikes.delete(ip);
    this.failures.delete(ip);
    if (had) {
      this.persist();
      console.log(`[jellybot-relay] ban remove ip=${ip}`);
    }
    return had;
  }

  listBans(): BanRecord[] {
    // Purge expired entries from the listing too.
    return [...this.bans.keys()].flatMap((ip) => {
      const rec = this.isBanned(ip);
      return rec ? [rec] : [];
    }).sort((a, b) => b.bannedAt - a.bannedAt);
  }

  checkRate(ip: string): { blocked: boolean; retryAfterSeconds: number } {
    const rec = this.failures.get(ip);
    if (!rec) return { blocked: false, retryAfterSeconds: 0 };
    if (rec.blockedUntil > Date.now()) {
      return { blocked: true, retryAfterSeconds: Math.ceil((rec.blockedUntil - Date.now()) / 1000) };
    }
    return { blocked: false, retryAfterSeconds: 0 };
  }

  /** Count a failed attempt; repeated lockouts escalate to an auto ban. */
  recordFailure(ip: string): { autoBanned: boolean } {
    const now = Date.now();
    const rec = this.failures.get(ip) ?? { failures: 0, windowStart: now, blockedUntil: 0 };
    if (now - rec.windowStart > RATE_WINDOW_MS) {
      rec.failures = 0;
      rec.windowStart = now;
    }
    rec.failures += 1;
    let autoBanned = false;
    if (rec.failures >= RATE_MAX_FAILURES) {
      rec.blockedUntil = now + RATE_BLOCK_MS;
      rec.failures = 0;
      const strikes = (this.strikes.get(ip) ?? 0) + 1;
      this.strikes.set(ip, strikes);
      if (strikes >= AUTO_BAN_STRIKES && !this.isBanned(ip)) {
        this.strikes.set(ip, 0);
        this.ban(ip, `auto: ${strikes} lockouts within window`, AUTO_BAN_TTL_MS);
        autoBanned = true;
      }
      this.persist();
      if (!autoBanned) {
        console.log(`[jellybot-relay] auth locked ip=${ip} strikes=${strikes}/${AUTO_BAN_STRIKES} for=${Math.round(RATE_BLOCK_MS / 60_000)}min`);
      }
    }
    this.failures.set(ip, rec);
    return { autoBanned };
  }

  clearFailures(ip: string): void {
    this.failures.delete(ip);
  }

  /** Recent failure/strike state for the Manage security card. */
  recentFailures(): FailureSnapshot[] {
    const now = Date.now();
    return [...this.failures.entries()]
      .map(([ip, rec]) => ({ ip, failures: rec.failures, strikes: this.strikes.get(ip) ?? 0, blockedUntil: rec.blockedUntil > now ? rec.blockedUntil : 0 }))
      .filter((snap) => snap.failures > 0 || snap.strikes > 0 || snap.blockedUntil > 0)
      .sort((a, b) => (b.blockedUntil - a.blockedUntil) || (b.strikes - a.strikes) || (b.failures - a.failures))
      .slice(0, 20);
  }

  /**
   * Throttled reject log for banned IPs hitting the entry point — one line
   * per IP per minute so a hammering client can't flood the journal.
   */
  noteRejected(ip: string, pathname: string): void {
    const now = Date.now();
    const last = this.lastRejectLog.get(ip) ?? 0;
    if (now - last < 60_000) return;
    this.lastRejectLog.set(ip, now);
    console.log(`[jellybot-relay] ban reject ip=${ip} path=${logSafe(pathname)}`);
  }

  /** Test hook. */
  resetForTests(): void {
    this.bans.clear();
    this.strikes.clear();
    this.failures.clear();
    this.lastRejectLog.clear();
  }
}

// ── HTTP endpoint handler ──────────────────────────────────────
function readJsonBody(req: import("node:http").IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
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

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export interface AuthEndpoints {
  /** Returns true when the request was handled (pathname under /api/auth/). */
  handle(pathname: string, req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<boolean>;
}

/**
 * Audit sink shape (subset of RelayStore.appendAudit) so the auth layer
 * never imports the store module. Login attempts land in the same audit
 * log the Manage view renders — IP included.
 */
export type AuthAuditSink = (actor: string, action: string, detail?: string) => void;

export function createAuthEndpoints(
  store: AuthStore,
  bans: IPBanStore,
  onAudit?: AuthAuditSink,
): AuthEndpoints {
  return {
    async handle(pathname, req, res) {
      if (!pathname.startsWith("/api/auth/")) return false;
      const ip = clientIpOf(req);
      // Banned IPs lose API access entirely — clean 403, throttled logging.
      const banRec = bans.isBanned(ip);
      if (banRec) {
        bans.noteRejected(ip, pathname);
        json(res, 403, { error: "ip_banned", reason: banRec.reason, expiresAt: banRec.expiresAt });
        return true;
      }

      if (req.method === "GET" && pathname === "/api/auth/captcha") {
        json(res, 200, createCaptcha());
        return true;
      }

      if (req.method === "POST" && pathname === "/api/auth/login") {
        const limit = bans.checkRate(ip);
        if (limit.blocked) {
          console.log(`[jellybot-relay] auth blocked ip=${ip} retry=${limit.retryAfterSeconds}s`);
          json(res, 429, { error: "too_many_attempts", retryAfterSeconds: limit.retryAfterSeconds });
          return true;
        }
        const body = await readJsonBody(req);
        const attemptedUser = typeof body.username === "string" ? logSafe(body.username) : "";
        // Every login attempt must clear a captcha first (fail-closed);
        // RELAY_DISABLE_CAPTCHA stays as the local dev/test escape hatch.
        if (
          process.env.RELAY_DISABLE_CAPTCHA !== "true" &&
          !verifyCaptcha(body.captchaId, body.captchaAnswer)
        ) {
          const { autoBanned } = bans.recordFailure(ip);
          onAudit?.(attemptedUser || "unknown", "loginFailed", `ip=${ip} · invalid_captcha`);
          if (!autoBanned) {
            console.log(`[jellybot-relay] auth fail ip=${ip} reason=invalid_captcha`);
            if (bans.checkRate(ip).blocked) {
              onAudit?.(attemptedUser || "unknown", "loginLocked", `ip=${ip} · throttled 15 min`);
            }
          }
          json(res, 401, { error: "invalid_captcha" });
          return true;
        }
        if (!store.verify(body.username, body.password)) {
          const { autoBanned } = bans.recordFailure(ip);
          onAudit?.(attemptedUser || "unknown", "loginFailed", `ip=${ip} · invalid_credentials`);
          if (!autoBanned) {
            console.log(`[jellybot-relay] auth fail ip=${ip} user="${logSafe(body.username)}" reason=invalid_credentials`);
            if (bans.checkRate(ip).blocked) {
              onAudit?.(attemptedUser || "unknown", "loginLocked", `ip=${ip} · throttled 15 min`);
            }
          }
          json(res, 401, { error: "invalid_credentials" });
          return true;
        }
        bans.clearFailures(ip);
        onAudit?.(store.username, "loginOk", `ip=${ip}`);
        console.log(`[jellybot-relay] auth ok ip=${ip} user=${store.username}`);
        const session = createSessionToken(store.username);
        json(res, 200, { ok: true, token: session.token, username: store.username, expiresAt: session.expiresAt });
        return true;
      }

      if (req.method === "POST" && pathname === "/api/auth/logout") {
        const body = await readJsonBody(req);
        destroySessionToken(body.token);
        json(res, 200, { ok: true });
        return true;
      }

      // ── security management (session-token guarded) ────────────
      const sessionFromHeader = () => verifySessionToken(req.headers["x-auth-token"]);

      if (req.method === "GET" && pathname === "/api/auth/security") {
        const session = sessionFromHeader();
        if (!session) {
          json(res, 401, { error: "invalid_session" });
          return true;
        }
        json(res, 200, {
          bans: bans.listBans(),
          failures: bans.recentFailures(),
          autoBanStrikes: AUTO_BAN_STRIKES,
          rateWindowMin: RATE_WINDOW_MS / 60_000,
        });
        return true;
      }

      if (req.method === "POST" && pathname === "/api/auth/ban") {
        const session = sessionFromHeader();
        if (!session) {
          json(res, 401, { error: "invalid_session" });
          return true;
        }
        const body = await readJsonBody(req);
        if (!isValidIp(body.ip)) {
          json(res, 400, { error: "invalid_ip" });
          return true;
        }
        const hours = typeof body.hours === "number" && body.hours > 0 && body.hours <= 24 * 365 ? body.hours : 0;
        bans.ban(body.ip, `manual by ${session.username}`, hours > 0 ? hours * 3600_000 : 0);
        json(res, 200, { ok: true });
        return true;
      }

      if (req.method === "POST" && pathname === "/api/auth/unban") {
        const session = sessionFromHeader();
        if (!session) {
          json(res, 401, { error: "invalid_session" });
          return true;
        }
        const body = await readJsonBody(req);
        if (!isValidIp(body.ip)) {
          json(res, 400, { error: "invalid_ip" });
          return true;
        }
        json(res, 200, { ok: bans.unban(body.ip) });
        return true;
      }

      if (req.method === "POST" && pathname === "/api/auth/password") {
        const body = await readJsonBody(req);
        const session = verifySessionToken(body.token);
        if (!session) {
          json(res, 401, { error: "invalid_session" });
          return true;
        }
        if (typeof body.currentPassword !== "string") {
          json(res, 400, { error: "current_password_required" });
          return true;
        }
        const nextUsername = typeof body.username === "string" ? body.username : undefined;
        const nextPassword = typeof body.password === "string" && body.password.length >= 4 ? body.password : undefined;
        if (!nextUsername && !nextPassword) {
          json(res, 400, { error: "nothing_to_change" });
          return true;
        }
        if (!store.update(body.currentPassword, { username: nextUsername, password: nextPassword })) {
          json(res, 401, { error: "invalid_credentials" });
          return true;
        }
        json(res, 200, { ok: true });
        return true;
      }

      json(res, 404, { error: "not found" });
      return true;
    },
  };
}
