export type AttachedFolderPrefs = { attached: string[]; detached: string[] };

const KEY_PREFIX = "devmode.attachedFolders:";

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

function same(a: string, b: string): boolean {
  return normalize(a).toLowerCase() === normalize(b).toLowerCase();
}

function storageKey(workspace: string): string {
  return KEY_PREFIX + normalize(workspace).toLowerCase();
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}

export function loadAttachedFolderPrefs(workspace: string, storage: Storage = localStorage): AttachedFolderPrefs {
  try {
    const parsed = JSON.parse(storage.getItem(storageKey(workspace)) ?? "null") as Record<string, unknown> | null;
    return { attached: strings(parsed?.attached), detached: strings(parsed?.detached) };
  } catch {
    return { attached: [], detached: [] };
  }
}

export function saveAttachedFolderPrefs(
  workspace: string,
  prefs: AttachedFolderPrefs,
  storage: Storage = localStorage,
): void {
  try {
    if (prefs.attached.length === 0 && prefs.detached.length === 0) storage.removeItem(storageKey(workspace));
    else storage.setItem(storageKey(workspace), JSON.stringify(prefs));
  } catch {
    return;
  }
}

export function mergeAttachedFolders(auto: readonly string[], prefs: AttachedFolderPrefs): string[] {
  const out: string[] = [];
  for (const dir of [...auto.filter((d) => !prefs.detached.some((x) => same(x, d))), ...prefs.attached]) {
    if (!out.some((x) => same(x, dir))) out.push(normalize(dir));
  }
  return out;
}

export function attachFolder(prefs: AttachedFolderPrefs, dir: string): AttachedFolderPrefs {
  return {
    attached: prefs.attached.some((x) => same(x, dir)) ? prefs.attached : [...prefs.attached, normalize(dir)],
    detached: prefs.detached.filter((x) => !same(x, dir)),
  };
}

export function detachFolder(
  prefs: AttachedFolderPrefs,
  dir: string,
  auto: readonly string[],
): AttachedFolderPrefs {
  const isAuto = auto.some((x) => same(x, dir));
  return {
    attached: prefs.attached.filter((x) => !same(x, dir)),
    detached: isAuto && !prefs.detached.some((x) => same(x, dir)) ? [...prefs.detached, normalize(dir)] : prefs.detached,
  };
}
