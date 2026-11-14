import { platform } from "node:os";
import { resolve } from "node:path";

/**
 * Process-wide per-path FIFO lock for file tools.
 *
 * Serializes write_file / patch / read_file across ALL
 * execution flows in this main process — parent turn, concurrent subagent
 * child turns (runTurn → runAgentTurn shares this process), and tool_call
 * bridge invocations. Writes exclude writes and reads (read waits for the
 * in-flight write to land); entry order is FIFO.
 *
 * Entry states (queue position 0 = current holder):
 * - reservation — streaming write claim (args still accumulating / waiting
 *   for permission approval). Holds the file at head or queues behind;
 *   TTL-releasable in every position; adopted in place by withFileLock.
 * - holder      — executing the real fs work. Released only by its own
 *   finally, or by a force sweep (Stop / stop_subagent cascade). TTL never
 *   force-releases an active holder.
 */

const IS_MAC = platform() === "darwin";

/** Write tools whose streaming args may reserve target files. */
export const FILE_WRITE_TOOL_NAMES = new Set<string>([
  "write_file",
  "patch",
]);

/** Read wait cap; on expiry read_file returns a retryable failure. */
export const FILE_LOCK_READ_TIMEOUT_MS = 15_000;
/** Write wait cap (queuing behind another holder). */
export const FILE_LOCK_WRITE_TIMEOUT_MS = 30_000;
/** Streaming reservation TTL — cleanup-only leak bound. */
export const FILE_LOCK_RESERVATION_TTL_MS = 90_000;

/** Error thrown when waiting for the lock times out. */
export class FileLockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileLockTimeoutError";
  }
}

/** Error thrown when a lock wait is aborted (user Stop / call cancel). */
export class FileLockAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileLockAbortError";
  }
}

/** Normalized lock key: resolved absolute path, lowercased on darwin. */
function lockKey(path: string): string {
  const abs = resolve(path);
  return IS_MAC ? abs.toLowerCase() : abs;
}

type Entry = {
  key: string;
  /** Absolute (display) path — the key may be case-folded. */
  path: string;
  /** sessionId:toolCallId — reservation / adopt token identity. */
  token: string;
  /** true = streaming reservation (TTL active); false = holder/holder-pending. */
  streaming: boolean;
  /** Reservation TTL deadline (streaming only; null once adopted). */
  expiresAt: number | null;
  /** Set only while a withFileLock caller waits for FIFO hand-off. */
  waiter: Waiter | null;
};

type Waiter = {
  resolve: () => void;
  reject: (err: Error) => void;
};

const entries = new Map<string, Entry[]>();
const seqCounter = { n: 0 };
let ttlTimer: ReturnType<typeof setInterval> | null = null;

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

/**
 * After a head entry goes away, promote the next entry:
 * a waiting withFileLock caller becomes the holder (resolve); a reservation
 * simply sits at head holding the file (TTL still armed).
 */
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

function hasAnyStreamingReservation(): boolean {
  for (const q of entries.values()) {
    for (const e of q) if (e.streaming) return true;
  }
  return false;
}

function armTtlTimer(): void {
  if (ttlTimer) return;
  ttlTimer = setInterval(() => {
    const now = Date.now();
    for (const [key, q] of [...entries]) {
      let pumped = false;
      for (const e of [...q]) {
        if (!e.streaming || e.expiresAt === null || e.expiresAt > now) continue;
        const wasHead = q.indexOf(e) === 0;
        removeEntry(key, e);
        if (wasHead && !pumped) {
          pump(key);
          pumped = true;
        }
      }
    }
    if (!hasAnyStreamingReservation()) disarmTtlTimer();
  }, 1_000);
  ttlTimer.unref?.(); // never keep the process alive for the sweeper
}

function disarmTtlTimer(): void {
  if (ttlTimer) {
    clearInterval(ttlTimer);
    ttlTimer = null;
  }
}

/** Find this token's reservation on a key's queue (streaming, unadopted). */
function findReservation(key: string, token: string): Entry | undefined {
  return entries.get(key)?.find((e) => e.token === token && e.streaming);
}

/**
 * Reserve a file while write args stream in (token = sessionId:toolCallId).
 * Enqueues a reservation claim at the tail; later adopted in place by
 * withFileLock (same token, FIFO position preserved). Idempotent per token.
 */
export function reserveStreamingWrite(
  path: string,
  token: string,
  opts?: { ttlMs?: number | undefined },
): void {
  const key = lockKey(path);
  const q = ensureQueue(key);
  if (findReservation(key, token)) return; // already reserved
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
  /** Abort while waiting in queue (best-effort for the body via caller). */
  signal?: AbortSignal | undefined;
  /** Wait cap while queued (ms). Defaults: write 30s / read 15s. */
  timeoutMs?: number | undefined;
  /** Adopt this token's streaming reservation (keep its FIFO slot). */
  adoptToken?: string | undefined;
};

export type FileLockKind = "write" | "read";

/**
 * Serialize `fn` against other flows on the same file. FIFO across
 * reservations and acquisitions. The lock releases when `fn` settles
 * (finally) — or early via a force sweep (then this finally is a no-op).
 */
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
    // Take over the reservation's queue position; drop its TTL clock.
    entry = adopted;
    entry.streaming = false;
    entry.expiresAt = null;
    entry.waiter = null; // adopted: claim as holder-pending
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

  // Acquire: we are at the head and not waiting (fresh empty queue, adopted
  // head reservation, or pumped predecessor). Otherwise wait for hand-off.
  if (q[0] !== entry || entry.waiter !== null) {
    if (!isHeadReady(q, entry)) {
      await waitForHead(key, entry, kind, opts);
    }
  }

  try {
    return await fn();
  } finally {
    // Idempotent: after a force sweep the entry is already gone.
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

/**
 * Release a streaming reservation by token — stream ended without a valid
 * call, argumentsError, permission deny/block, or a non-adopted duplicate.
 * Idempotent; no-op after adoption (the holder's finally releases).
 */
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
  // Fallback: drop same-token reservations on any path (args.path vs the
  // streamed path may differ in form; token identity is authoritative).
  for (const [key, q] of [...entries]) {
    for (const e of [...q]) {
      if (e.token !== token || !e.streaming) continue;
      const wasHead = q.indexOf(e) === 0;
      removeEntry(key, e);
      if (wasHead) pump(key);
    }
  }
  if (!hasAnyStreamingReservation()) disarmTtlTimer();
}

export type SweepOptions = {
  /** Force: also release active holders (Stop / stop_subagent cascade). */
  force?: boolean;
};

/**
 * Sweep this turn's entries (token prefix = "sessionId:").
 * Normal end: drop queued reservations only (holders release themselves).
 * Abort/Stop (force): drop everything the turn owns — active holders
 * included. Their later `finally` release is a no-op (idempotent); the
 * in-flight fs promise may still land afterwards — accepted degradation on
 * a path the user already cancelled.
 */
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
  if (!hasAnyStreamingReservation()) disarmTtlTimer();
}

/** Test hook: live entry count (total, across paths). */
export function fileLockEntryCountForTests(): number {
  let n = 0;
  for (const q of entries.values()) n += q.length;
  return n;
}

let FILE_LOCK_READ_TIMEOUT_MS_OVERRIDE: number | null = null;
let FILE_LOCK_WRITE_TIMEOUT_MS_OVERRIDE: number | null = null;
let FILE_LOCK_RESERVATION_TTL_MS_OVERRIDE: number | null = null;

/** Test hook: shorten the wait caps / TTL (pass null to restore). */
export function setFileLockTimeoutsForTests(opts: {
  readMs?: number | null;
  writeMs?: number | null;
  ttlMs?: number | null;
}): void {
  FILE_LOCK_READ_TIMEOUT_MS_OVERRIDE = opts.readMs ?? null;
  FILE_LOCK_WRITE_TIMEOUT_MS_OVERRIDE = opts.writeMs ?? null;
  FILE_LOCK_RESERVATION_TTL_MS_OVERRIDE = opts.ttlMs ?? null;
}

/** Test hook: full reset. */
export function resetFileLocksForTests(): void {
  entries.clear();
  disarmTtlTimer();
  seqCounter.n = 0;
}

/**
 * Best-effort "path" extraction from a partial / streaming JSON args body.
 * Mirrors the renderer's parsePartialWriteArgs intent: find the top-level
 * "path" string property even when later fields are still streaming.
 */
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
  if (!trimmed.startsWith("/")) return null; // not absolute yet / garbage
  return trimmed;
}

/**
 * Re-key a reservation's token in place (delta id transition pending-N →
 * real id): keeps the queue position. If the new token already owns a
 * reservation on this path, the old one is dropped instead.
 */
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

/** Build the accounting token from context ids. */
export function fileLockToken(
  sessionId: string | undefined,
  toolCallId: string | undefined,
): string {
  return `${sessionId ?? "session"}:${toolCallId ?? `anon-${nextSeq()}`}`;
}
