/**
 * Keyed composer prefs store (Run Mode / Infinite / Reasoning Effort /
 * Turn Handoff / optional custom FSM graph id).
 *
 * Key = sessionId for conversations, or COMPOSER_DRAFT_KEY for the New Task
 * composer. Each key keeps only *pinned* fields; unpinned fields resolve
 * from process-wide defaults seeded from settings.json at bootstrap
 * (NULL-on-row semantics from schema v14).
 *
 * - Session-key changes persist through `agent:setComposerPrefs` (atomic,
 *   one IPC per patch).
 * - Draft changes stay local and are pinned onto the row at session creation
 *   (never written back to settings.json). Custom mode is session-scoped
 *   only (not an app-wide settings default).
 */

export type ComposerRunMode = "agent" | "ask" | "plan" | "custom";

/** Renderer mirror of the reasoning-effort dial (see src/llm/reasoningEffort.ts). */
type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "off" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max"
  );
}

export type SessionComposerPrefs = {
  runMode: ComposerRunMode;
  /** Library graph id when runMode is custom; otherwise null. */
  fsmGraphId: string | null;
  infinite: boolean;
  /** Reasoning-effort dial level (off/low/medium/high/max). */
  reasoningEffort: ReasoningEffort;
  /** Turn Handoff gate (session-scoped only; no app-wide default). */
  handoffEnabled: boolean;
};

/** New Task composer key (not a session id). */
export const COMPOSER_DRAFT_KEY = "draft";

let defaults: SessionComposerPrefs = {
  runMode: "agent",
  fsmGraphId: null,
  infinite: false,
  reasoningEffort: "low",
  handoffEnabled: false,
};

/** key → pinned fields only (unpinned fields follow `defaults`). */
const pinned = new Map<string, Partial<SessionComposerPrefs>>();

/** Per-key count of in-flight agent:setComposerPrefs writes. */
const inflightWrites = new Map<string, number>();

const listeners = new Map<string, Set<(prefs: SessionComposerPrefs) => void>>();

function resolve(key: string): SessionComposerPrefs {
  const merged = { ...defaults, ...pinned.get(key) };
  if (merged.runMode !== "custom") {
    merged.fsmGraphId = null;
  }
  return merged;
}

function emit(key: string): void {
  const snapshot = resolve(key);
  for (const listener of listeners.get(key) ?? []) {
    listener(snapshot);
  }
}

export function getComposerPrefs(key: string): SessionComposerPrefs {
  return resolve(key);
}

/** Seed process-wide defaults from settings.json (app bootstrap; no write-back). */
export function seedComposerPrefsDefaults(
  next: Partial<SessionComposerPrefs>,
): void {
  const safe = { ...next };
  // App-wide defaults never pin custom graphs.
  if (safe.runMode === "custom") delete safe.runMode;
  if ("fsmGraphId" in safe) delete safe.fsmGraphId;
  defaults = { ...defaults, ...safe };
}

/**
 * Hydrate a session key's pinned fields from its session row (schema v14;
 * null/absent → unpinned). Local only — the row is already the source of
 * truth, so no IPC write.
 */
export function hydrateComposerPrefs(
  key: string,
  prefs: {
    runMode?: ComposerRunMode | null;
    fsmGraphId?: string | null;
    infinite?: boolean | null;
    reasoningEffort?: ReasoningEffort | null;
    handoffEnabled?: boolean | null;
  } | null | undefined,
): void {
  // Skip while our own write is in flight — a concurrent session refresh
  // still carries the pre-write row and would roll the UI back. The next
  // refresh (post-write) reconciles from the persisted truth.
  if ((inflightWrites.get(key) ?? 0) > 0) return;
  const next: Partial<SessionComposerPrefs> = {};
  if (
    prefs?.runMode === "agent" ||
    prefs?.runMode === "ask" ||
    prefs?.runMode === "plan" ||
    prefs?.runMode === "custom"
  ) {
    next.runMode = prefs.runMode;
  }
  if (prefs?.runMode === "custom") {
    const id =
      typeof prefs.fsmGraphId === "string" && prefs.fsmGraphId.trim()
        ? prefs.fsmGraphId.trim()
        : null;
    if (id) {
      next.fsmGraphId = id;
    } else {
      // custom without id → fall back to Auto
      next.runMode = "agent";
      next.fsmGraphId = null;
    }
  } else if (prefs?.runMode === "agent" || prefs?.runMode === "ask" || prefs?.runMode === "plan") {
    next.fsmGraphId = null;
  }
  if (typeof prefs?.infinite === "boolean") next.infinite = prefs.infinite;
  // null/absent → un-pinned (field left out; resolves to process defaults).
  if (isReasoningEffort(prefs?.reasoningEffort)) {
    next.reasoningEffort = prefs.reasoningEffort;
  }
  if (typeof prefs?.handoffEnabled === "boolean") {
    next.handoffEnabled = prefs.handoffEnabled;
  }
  pinned.set(key, next);
  emit(key);
}

function persistSessionPrefs(
  sessionId: string,
  patch: Partial<SessionComposerPrefs>,
): void {
  if (typeof window === "undefined" || !window.jellybot?.setComposerPrefs) {
    return;
  }
  inflightWrites.set(sessionId, (inflightWrites.get(sessionId) ?? 0) + 1);
  void window.jellybot
    .setComposerPrefs(sessionId, {
      ...(patch.runMode !== undefined ? { runMode: patch.runMode } : {}),
      ...(patch.fsmGraphId !== undefined
        ? { fsmGraphId: patch.fsmGraphId }
        : {}),
      ...(patch.infinite !== undefined ? { infinite: patch.infinite } : {}),
      ...(patch.reasoningEffort !== undefined
        ? { reasoningEffort: patch.reasoningEffort }
        : {}),
      ...(patch.handoffEnabled !== undefined
        ? { handoffEnabled: patch.handoffEnabled }
        : {}),
    })
    .catch((err: unknown) => {
      console.error("[composer] persist session prefs failed", err);
    })
    .finally(() => {
      const remaining = (inflightWrites.get(sessionId) ?? 1) - 1;
      if (remaining > 0) inflightWrites.set(sessionId, remaining);
      else inflightWrites.delete(sessionId);
    });
}

/**
 * Apply a change for a key (merged over the key's pinned fields).
 * Session keys persist through one atomic `agent:setComposerPrefs` call;
 * the draft key stays local until its session is created — but its
 * Infinite / Reasoning Max changes also become the New Task defaults:
 * seeded process-wide and written back to settings.json (the next app
 * start's bootstrap source). Conversational sessions never write back.
 */
export function setComposerPrefsFor(
  key: string,
  patch: Partial<SessionComposerPrefs>,
): void {
  const normalized: Partial<SessionComposerPrefs> = { ...patch };
  if (
    normalized.runMode === "agent" ||
    normalized.runMode === "ask" ||
    normalized.runMode === "plan"
  ) {
    normalized.fsmGraphId = null;
  }
  if (normalized.runMode === "custom" && !normalized.fsmGraphId) {
    // Selecting custom without an id is invalid — callers always pass id.
    // Guard: keep prior fsmGraphId from pinned if present.
    const prior = pinned.get(key)?.fsmGraphId;
    if (prior) normalized.fsmGraphId = prior;
  }
  pinned.set(key, { ...pinned.get(key), ...normalized });
  emit(key);
  if (key === COMPOSER_DRAFT_KEY) {
    persistDraftDefaults(normalized);
  } else {
    persistSessionPrefs(key, normalized);
  }
}

/**
 * Draft (New Task) Infinite / Reasoning Max changes become the defaults:
 * seed the process-wide defaults (unpinned sessions follow) and persist to
 * settings.json so the values survive restarts. Run Mode keeps the legacy
 * draft-local semantics (including custom + fsmGraphId).
 */
function persistDraftDefaults(patch: Partial<SessionComposerPrefs>): void {
  const next: Partial<SessionComposerPrefs> = {};
  if (patch.infinite !== undefined) next.infinite = patch.infinite;
  if (patch.reasoningEffort !== undefined) {
    next.reasoningEffort = patch.reasoningEffort;
  }
  if (Object.keys(next).length === 0) return;
  seedComposerPrefsDefaults(next);
  if (typeof window === "undefined" || !window.jellybot) return;
  try {
    if (next.infinite !== undefined) {
      void window.jellybot.setComposerInfinite(next.infinite).catch(
        (err: unknown) => {
          console.error("[composer] persist draft infinite failed", err);
        },
      );
    }
    if (next.reasoningEffort !== undefined) {
      void window.jellybot.setReasoningEffort(next.reasoningEffort).catch(
        (err: unknown) => {
          console.error("[composer] persist draft reasoningEffort failed", err);
        },
      );
    }
  } catch {
    // Bridge hiccups must not break the local toggle.
  }
}

/** Subscribe to a key's resolved prefs (fires only on that key's changes). */
export function subscribeComposerPrefs(
  key: string,
  listener: (prefs: SessionComposerPrefs) => void,
): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
  };
}

/** Test seam: drop all pinned fields + listeners. */
export function resetComposerPrefsForTest(): void {
  pinned.clear();
  listeners.clear();
  defaults = {
    runMode: "agent",
    fsmGraphId: null,
    infinite: false,
    reasoningEffort: "low",
    handoffEnabled: false,
  };
}
