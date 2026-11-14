/**
 * Per-session composer draft stash (localStorage-backed).
 *
 * Key = sessionId for conversations, or COMPOSER_DRAFT_KEY ("draft") for the
 * New Task composer. Un-submitted prompt text is auto-stashed (debounced by
 * the controllers) so switching sessions and back restores what was typed.
 * Drafts survive app restarts; they are cleared on send (the text becomes a
 * real user message / pending steer).
 *
 * Storage is best-effort: without localStorage (node tests, private mode,
 * quota errors) reads return "" and writes no-op — never throw into the
 * composer input path.
 */

const KEY_PREFIX = "jellybot:composer-draft:";

/** Skip stashing pathologically large pastes; keep the previous draft. */
const MAX_DRAFT_CHARS = 200_000;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function keyFor(key: string): string {
  return `${KEY_PREFIX}${key}`;
}

export function getSessionDraft(key: string): string {
  const store = storage();
  if (!store) return "";
  try {
    const raw = store.getItem(keyFor(key));
    return typeof raw === "string" ? raw : "";
  } catch {
    return "";
  }
}

/** Stash draft text; an empty/whitespace-only draft removes the key. */
export function setSessionDraft(key: string, text: string): void {
  const store = storage();
  if (!store) return;
  if (text.length > MAX_DRAFT_CHARS) return;
  const storageKey = keyFor(key);
  try {
    if (text.trim().length === 0) {
      store.removeItem(storageKey);
    } else {
      store.setItem(storageKey, text);
    }
  } catch {
    // Quota / private-mode hiccups must not break typing.
  }
}

export function clearSessionDraft(key: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(keyFor(key));
  } catch {
    // Ignore — a stale draft is cosmetic.
  }
}
