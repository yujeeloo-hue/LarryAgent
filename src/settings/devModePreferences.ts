export const DEV_MODE_FONT_FAMILIES = {
  system: 'ui-monospace, "SF Mono", "JetBrains Mono Var", SFMono-Regular, Menlo, Monaco, Consolas, "Courier New", monospace',
  jetbrains: '"JetBrains Mono Var", monospace',
  cascadia: '"Cascadia Code", "JetBrains Mono Var", monospace',
  consolas: 'Consolas, "JetBrains Mono Var", monospace',
  menlo: 'Menlo, "JetBrains Mono Var", monospace',
} as const;

export type DevModePreferences = {
  precompile: boolean;
  liveCoding: boolean;
  syntaxTheme: "auto" | "light" | "dark" | "contrast";
  fontFamily: keyof typeof DEV_MODE_FONT_FAMILIES;
  fontSize: number;
};

export const DEV_MODE_FONT_SIZE_MIN = 8;
export const DEV_MODE_FONT_SIZE_MAX = 40;
export const DEFAULT_DEV_MODE_PREFERENCES: Readonly<DevModePreferences> = {
  precompile: true,
  liveCoding: false,
  syntaxTheme: "auto",
  fontFamily: "system",
  fontSize: 12.5,
};

export function normalizeDevModePreferences(value: unknown): DevModePreferences {
  const input = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    precompile: input.precompile !== false,
    liveCoding: input.liveCoding === true,
    syntaxTheme: input.syntaxTheme === "light" || input.syntaxTheme === "dark" || input.syntaxTheme === "contrast"
      ? input.syntaxTheme : "auto",
    fontFamily: typeof input.fontFamily === "string" && Object.hasOwn(DEV_MODE_FONT_FAMILIES, input.fontFamily)
      ? input.fontFamily as DevModePreferences["fontFamily"] : "system",
    fontSize: typeof input.fontSize === "number" && Number.isFinite(input.fontSize)
      ? Math.min(DEV_MODE_FONT_SIZE_MAX, Math.max(DEV_MODE_FONT_SIZE_MIN, Math.round(input.fontSize * 2) / 2))
      : DEFAULT_DEV_MODE_PREFERENCES.fontSize,
  };
}
