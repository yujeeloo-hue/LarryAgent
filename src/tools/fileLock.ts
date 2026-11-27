import { platform } from "node:os";
import { resolve } from "node:path";


const IS_MAC = platform() === "darwin";

export const FILE_WRITE_TOOL_NAMES = new Set<string>([
  "write_file",
  "patch",
]);

export const FILE_LOCK_READ_TIMEOUT_MS = 15_000;
export const FILE_LOCK_WRITE_TIMEOUT_MS = 30_000;
export const FILE_LOCK_RESERVATION_TTL_MS = 90_000;

export class FileLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileLockTimeoutError";
  }
}

export class FileLockAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileLockAbortError";
  }
}

function lockKey(path: string): string {
  const abs = resolve(path);
  return IS_MAC ? abs.toLowerCase() : abs;
}

type Entry = {
  key: string;
  path: string;
  token: string;
  streaming: boolean;
  expiresAt: number | null;
  waiter: Waiter | null;
};

type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
};

const entries = new Map<string, Entry[]>();
const seqCounter = { n: 0 };
let ttlTimer: ReturnType<typeof setTimeout> | null = null;

function ensureQueue(key: string): Entry[] {
  let q = entries.get(key);
  if (!q) {
    q = [];
    entries.set(key, q);
  }
  return q;
}

function nextSeq(): number {
  seqCounter.n += 1;
  return seqCounter.n;
}

function removeEntry(key: string, entry: Entry): void {
  const q = entries.get(key);
  if (!q) return;
  const idx = q.indexOf(entry);
  if (idx >= 0) q.splice(idx, 1);
  if (q.length === 0) entries.delete(key);
}

function pump(key: string): void {
  const q = entries.get(key);
  if (!q || q.length === 0) {
    entries.delete(key);
    return;
  }
  const head = q[0];
  if (head?.waiter) {
    const w = head.waiter;
    head.waiter = null;
    head.streaming = false;
    head.expiresAt = null;
    w.resolve();
  }
}

function earliestStreamingExpiry(): number | null {
  let next: number | null = null;
  for (const q of entries.values()) {
    for (const entry of q) {
      if (!entry.streaming || entry.expiresAt === null) continue;
      if (next === null || entry.expiresAt < next) next = entry.expiresAt;
    }
  }
  return next;
}

function expireStreamingReservations(now: number): void {
  for (const [key, q] of [...entries]) {
    let pumped = false;
    for (const entry of [...q]) {
      if (!entry.streaming || entry.expiresAt === null || entry.expiresAt > now) continue;
      const wasHead = q.indexOf(entry) === 0;
      removeEntry(key, entry);
      if (wasHead && !pumped) {
        pump(key);
        pumped = true;
      }
    }
  }
}

function armTtlTimer(): void {
  if (ttlTimer) {
    clearTimeout(ttlTimer);
    ttlTimer = null;
  }
  const next = earliestStreamingExpiry();
  if (next === null) return;
  ttlTimer = setTimeout(() => {
    ttlTimer = null;
    expireStreamingReservations(Date.now());
    armTtlTimer();
  }, Math.max(0, next - Date.now()));
  ttlTimer.unref?.();
}

function disarmTtlTimer(): void {
  if (ttlTimer) {
    clearTimeout(ttlTimer);
    ttlTimer = null;
  }
}

function findReservation(key: string, token: string): Entry | undefined {
  return entries.get(key)?.find((e) => e.token === token && e.streaming);
}

export function reserveStreamingWrite(
  path: string,
  token: string,
  opts?: { ttlMs?: number | undefined },
): void {
  const key = lockKey(path);
  const q = ensureQueue(key);
  if (findReservation(key, token)) return;
  q.push({
    key,
    path,
    token,
    streaming: true,
    expiresAt:
      Date.now() +
      (opts?.ttlMs ?? FILE_LOCK_RESERVATION_TTL_MS_OVERRIDE ??
        FILE_LOCK_RESERVATION_TTL_MS),
    waiter: null,
  });
  armTtlTimer();
}

export type WithFileLockOptions = {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
  adoptToken?: string | undefined;
};

export type FileLockKind = "write" | "read";

export async function withFileLock<T>(
  path: string,
  kind: FileLockKind,
  opts: WithFileLockOptions,
  fn: () => Promise<T>,
): Promise<T> {
  const key = lockKey(path);
  const q = ensureQueue(key);

  const adopted = opts.adoptToken
    ? findReservation(key, opts.adoptToken)
    : undefined;

  let entry: Entry;
  if (adopted) {
    entry = adopted;
    entry.streaming = false;
    entry.expiresAt = null;
    entry.waiter = null;
    armTtlTimer();
  } else {
    entry = {
      key,
      path,
      token: opts.adoptToken ?? `anon:${nextSeq()}`,
      streaming: false,
      expiresAt: null,
      waiter: null,
    };
    q.push(entry);
  }

  if (q[0] !== entry || entry.waiter !== null) {
    if (!isHeadReady(q, entry)) {
      await waitForHead(key, entry, kind, opts);
    }
  }

  try {
    return await fn();
  } finally {
    const wasHead = entries.get(key)?.[0] === entry;
    removeEntry(key, entry);
    if (wasHead) pump(key);
  }
}

function isHeadReady(q: Entry[], entry: Entry): boolean {
  return q[0] === entry && entry.waiter === null;
}

async function waitForHead(
  key: string,
  entry: Entry,
  kind: FileLockKind,
  opts: WithFileLockOptions,
): Promise<void> {
  const timeoutMs =
    opts.timeoutMs ??
    (kind === "read"
      ? FILE_LOCK_READ_TIMEOUT_MS_OVERRIDE ?? FILE_LOCK_READ_TIMEOUT_MS
      : FILE_LOCK_WRITE_TIMEOUT_MS_OVERRIDE ?? FILE_LOCK_WRITE_TIMEOUT_MS);

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const abandon = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      const wasHead = entries.get(key)?.[0] === entry;
      removeEntry(key, entry);
      if (wasHead) pump(key);
      reject(err);
    };

    const timer = setTimeout(
      () =>
        abandon(
          new FileLockTimeoutError(
            `Timed out after ${timeoutMs}ms waiting for the file lock on ${entry.path}`,
          ),
        ),
      timeoutMs,
    );

    const onAbort = () =>
      abandon(new FileLockAbortError(`File lock wait on ${entry.path} was aborted`));
    if (opts.signal) {
      if (opts.signal.aborted) {
        abandon(
          new FileLockAbortError(`File lock wait on ${entry.path} was aborted`),
        );
        return;
      }
      opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    entry.waiter = {
      resolve: () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onAbort);
        entry.waiter = null;
        resolve();
      },
      reject: (err: Error) => abandon(err),
    };
  });
}

export function releaseStreamingReservation(
  path: string | null,
  token: string,
): void {
  if (path) {
    const key = lockKey(path);
    const entry = findReservation(key, token);
    if (entry) {
      const wasHead = entries.get(key)?.[0] === entry;
      removeEntry(key, entry);
      if (wasHead) pump(key);
    }
  }
  for (const [key, q] of [...entries]) {
    for (const e of [...q]) {
      if (e.token !== token || !e.streaming) continue;
      const wasHead = q.indexOf(e) === 0;
      removeEntry(key, e);
      if (wasHead) pump(key);
    }
  }
  armTtlTimer();
}

export type SweepOptions = {
  force?: boolean;
};

export function sweepTurnFileLocks(
  sessionId: string,
  opts?: SweepOptions,
): void {
  const force = opts?.force === true;
  const prefix = `${sessionId}:`;
  for (const [key, q] of [...entries]) {
    for (const e of [...q]) {
      if (!e.token.startsWith(prefix)) continue;
      const isReservation = e.streaming;
      if (!isReservation && !force) continue;
      const wasHead = q.indexOf(e) === 0;
      removeEntry(key, e);
      if (wasHead) pump(key);
      if (e.waiter) {
        e.waiter.reject(
          new Error(`File lock on ${e.path} released by turn sweep`),
        );
      }
    }
  }
  armTtlTimer();
}

export function fileLockEntryCountForTests(): number {
  let n = 0;
  for (const q of entries.values()) n += q.length;
  return n;
}

let FILE_LOCK_READ_TIMEOUT_MS_OVERRIDE: number | null = null;
let FILE_LOCK_WRITE_TIMEOUT_MS_OVERRIDE: number | null = null;
let FILE_LOCK_RESERVATION_TTL_MS_OVERRIDE: number | null = null;

export function setFileLockTimeoutsForTests(opts: {
  readMs?: number | null;
  writeMs?: number | null;
  ttlMs?: number | null;
}): void {
  FILE_LOCK_READ_TIMEOUT_MS_OVERRIDE = opts.readMs ?? null;
  FILE_LOCK_WRITE_TIMEOUT_MS_OVERRIDE = opts.writeMs ?? null;
  FILE_LOCK_RESERVATION_TTL_MS_OVERRIDE = opts.ttlMs ?? null;
}

export function resetFileLocksForTests(): void {
  entries.clear();
  disarmTtlTimer();
  seqCounter.n = 0;
}

export function extractPartialPath(rawArgs: string): string | null {
  if (!rawArgs || rawArgs.length < 8) return null;
  if (!rawArgs.includes('"path"')) return null;
  const m = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(rawArgs);
  if (!m) return null;
  let value: string;
  try {
    value = JSON.parse(`"${m[1]}"`);
  } catch {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return null;
  return trimmed;
}

export function rekeyStreamingReservation(
  path: string,
  oldToken: string,
  newToken: string,
): void {
  if (oldToken === newToken) return;
  const key = lockKey(path);
  const q = entries.get(key);
  if (!q) return;
  const old = q.find((e) => e.token === oldToken && e.streaming);
  if (!old) return;
  const dup = q.find((e) => e.token === newToken && e.streaming);
  if (dup && dup !== old) {
    const wasHead = q.indexOf(old) === 0;
    removeEntry(key, old);
    if (wasHead) pump(key);
    return;
  }
  old.token = newToken;
}

export function fileLockToken(
  sessionId: string | undefined,
  toolCallId: string | undefined,
): string {
  return `${sessionId ?? "session"}:${toolCallId ?? `anon-${nextSeq()}`}`;
}
