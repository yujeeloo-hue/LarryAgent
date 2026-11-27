
const KEY_PREFIX = "jellybot:composer-draft:";

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
  }
}

export function clearSessionDraft(key: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(keyFor(key));
  } catch {
  }
}
