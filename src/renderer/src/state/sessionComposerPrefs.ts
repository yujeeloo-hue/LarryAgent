
export type ComposerRunMode = "agent" | "ask" | "plan" | "custom";

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
  fsmGraphId: string | null;
  infinite: boolean;
  reasoningEffort: ReasoningEffort;
};

export const COMPOSER_DRAFT_KEY = "draft";

let defaults: SessionComposerPrefs = {
  runMode: "agent",
  fsmGraphId: null,
  infinite: false,
  reasoningEffort: "low",
};

const pinned = new Map<string, Partial<SessionComposerPrefs>>();

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

export function seedComposerPrefsDefaults(
  next: Partial<SessionComposerPrefs>,
): void {
  const safe = { ...next };
  if (safe.runMode === "custom") delete safe.runMode;
  if ("fsmGraphId" in safe) delete safe.fsmGraphId;
  defaults = { ...defaults, ...safe };
}

export function hydrateComposerPrefs(
  key: string,
  prefs: {
    runMode?: ComposerRunMode | null;
    fsmGraphId?: string | null;
    infinite?: boolean | null;
    reasoningEffort?: ReasoningEffort | null;
  } | null | undefined,
): void {
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
      next.runMode = "agent";
      next.fsmGraphId = null;
    }
  } else if (prefs?.runMode === "agent" || prefs?.runMode === "ask" || prefs?.runMode === "plan") {
    next.fsmGraphId = null;
  }
  if (typeof prefs?.infinite === "boolean") next.infinite = prefs.infinite;
  if (isReasoningEffort(prefs?.reasoningEffort)) {
    next.reasoningEffort = prefs.reasoningEffort;
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
  }
}

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

export function resetComposerPrefsForTest(): void {
  pinned.clear();
  listeners.clear();
  defaults = {
    runMode: "agent",
    fsmGraphId: null,
    infinite: false,
    reasoningEffort: "low",
  };
}
