import type { ComputerUsePlatform } from "./types.js";

export type KeySpec = { code: number; extended: boolean };

export type ResolvedModifier = KeySpec & {
  /** Canonical name; on macOS this is also the CGEventFlags name the helper understands. */
  name: string;
};

const MAC_SPECIAL_KEYS: Record<string, number> = {
  return: 36, enter: 36, tab: 48, space: 49,
  delete: 51, backspace: 51, escape: 53, esc: 53,
  forward_delete: 117, home: 115, end: 119,
  pageup: 116, pagedown: 121,
  up: 126, down: 125, left: 123, right: 124,
  caps_lock: 57, help: 114,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97,
  f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
  cmd: 55, command: 55, shift: 56, option: 58, alt: 58,
  control: 59, ctrl: 59, fn: 63,
};

const WIN_SPECIAL_KEYS: Record<string, KeySpec> = {
  return: { code: 0x0d, extended: false }, enter: { code: 0x0d, extended: false },
  tab: { code: 0x09, extended: false }, space: { code: 0x20, extended: false },
  backspace: { code: 0x08, extended: false }, delete: { code: 0x2e, extended: true },
  forward_delete: { code: 0x2e, extended: true },
  escape: { code: 0x1b, extended: false }, esc: { code: 0x1b, extended: false },
  home: { code: 0x24, extended: true }, end: { code: 0x23, extended: true },
  pageup: { code: 0x21, extended: true }, pagedown: { code: 0x22, extended: true },
  insert: { code: 0x2d, extended: true },
  up: { code: 0x26, extended: true }, down: { code: 0x28, extended: true },
  left: { code: 0x25, extended: true }, right: { code: 0x27, extended: true },
  caps_lock: { code: 0x14, extended: false }, help: { code: 0x2f, extended: false },
  f1: { code: 0x70, extended: false }, f2: { code: 0x71, extended: false },
  f3: { code: 0x72, extended: false }, f4: { code: 0x73, extended: false },
  f5: { code: 0x74, extended: false }, f6: { code: 0x75, extended: false },
  f7: { code: 0x76, extended: false }, f8: { code: 0x77, extended: false },
  f9: { code: 0x78, extended: false }, f10: { code: 0x79, extended: false },
  f11: { code: 0x7a, extended: false }, f12: { code: 0x7b, extended: false },
  ctrl: { code: 0x11, extended: false }, control: { code: 0x11, extended: false },
  cmd: { code: 0x11, extended: false }, command: { code: 0x11, extended: false },
  shift: { code: 0x10, extended: false },
  alt: { code: 0x12, extended: false }, option: { code: 0x12, extended: false },
  win: { code: 0x5b, extended: true }, super: { code: 0x5b, extended: true },
  meta: { code: 0x5b, extended: true },
};

// US ANSI virtual keycodes: shortcuts such as cmd+c must carry a real keycode, not only a Unicode string.
const MAC_ANSI_KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12,
  w: 13, e: 14, r: 15, y: 16, t: 17, "1": 18, "2": 19, "3": 20, "4": 21,
  "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29,
  "]": 30, o: 31, u: 32, "[": 33, i: 34, p: 35, l: 37, j: 38, "'": 39,
  k: 40, ";": 41, "\\": 42, ",": 43, "/": 44, n: 45, m: 46, ".": 47, "`": 50,
  " ": 49,
};

const MAC_MODIFIERS: Record<string, ResolvedModifier> = {
  cmd: { name: "cmd", code: 55, extended: false },
  command: { name: "cmd", code: 55, extended: false },
  win: { name: "cmd", code: 55, extended: false },
  super: { name: "cmd", code: 55, extended: false },
  meta: { name: "cmd", code: 55, extended: false },
  shift: { name: "shift", code: 56, extended: false },
  option: { name: "option", code: 58, extended: false },
  alt: { name: "option", code: 58, extended: false },
  control: { name: "control", code: 59, extended: false },
  ctrl: { name: "control", code: 59, extended: false },
  fn: { name: "fn", code: 63, extended: false },
};

// cmd maps to Ctrl so that cross-platform shortcuts like ["cmd", "c"] keep their meaning.
const WIN_MODIFIERS: Record<string, ResolvedModifier> = {
  cmd: { name: "ctrl", code: 0x11, extended: false },
  command: { name: "ctrl", code: 0x11, extended: false },
  ctrl: { name: "ctrl", code: 0x11, extended: false },
  control: { name: "ctrl", code: 0x11, extended: false },
  shift: { name: "shift", code: 0x10, extended: false },
  alt: { name: "alt", code: 0x12, extended: false },
  option: { name: "alt", code: 0x12, extended: false },
  win: { name: "win", code: 0x5b, extended: true },
  super: { name: "win", code: 0x5b, extended: true },
  meta: { name: "win", code: 0x5b, extended: true },
};

export class KeyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyResolutionError";
  }
}

function modifierTable(platform: ComputerUsePlatform): Record<string, ResolvedModifier> {
  return platform === "macos" ? MAC_MODIFIERS : WIN_MODIFIERS;
}

export function modifierNames(platform: ComputerUsePlatform): string[] {
  return Object.keys(modifierTable(platform)).sort();
}

export function isModifierName(name: string, platform: ComputerUsePlatform): boolean {
  return Object.hasOwn(modifierTable(platform), name.trim().toLowerCase());
}

/** Resolves modifier names in order, dropping duplicates (e.g. "cmd" + "ctrl" on Windows). */
export function resolveModifiers(
  names: readonly string[] | undefined,
  platform: ComputerUsePlatform,
): ResolvedModifier[] {
  const table = modifierTable(platform);
  const out: ResolvedModifier[] = [];
  for (const raw of names ?? []) {
    const key = raw.trim().toLowerCase();
    const found = table[key];
    if (!found) {
      throw new KeyResolutionError(
        `Unknown modifier "${raw}". Use one of: ${modifierNames(platform).join(", ")}.`,
      );
    }
    if (!out.some((m) => m.name === found.name)) out.push(found);
  }
  return out;
}

export function resolveSpecialKey(
  name: string,
  platform: ComputerUsePlatform,
): KeySpec | null {
  const key = name.trim().toLowerCase();
  if (platform === "macos") {
    const code = MAC_SPECIAL_KEYS[key];
    return code === undefined ? null : { code, extended: false };
  }
  return WIN_SPECIAL_KEYS[key] ?? null;
}

export function macKeycodeForChar(char: string): number | null {
  const code = MAC_ANSI_KEYCODES[char.toLowerCase()];
  return code === undefined ? null : code;
}

export type MainKey =
  | { kind: "special"; key: KeySpec }
  | { kind: "char"; char: string };

/** A key is either a special key name ("return", "f5", "cmd"…) or exactly one character (any script). */
export function parseMainKey(key: string, platform: ComputerUsePlatform): MainKey {
  const special = resolveSpecialKey(key, platform);
  if (special) return { kind: "special", key: special };
  if (Array.from(key).length === 1) return { kind: "char", char: key };
  throw new KeyResolutionError(
    `Unrecognized key "${key}". Use a special key name (return, tab, esc, up, f5…) or a single character; use action "type" for text.`,
  );
}
