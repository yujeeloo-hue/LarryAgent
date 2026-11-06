import { app } from "electron";
import { readWorkspaceSettings } from "../settings/index.js";
import { resolveThemeId } from "../settings/types.js";

/**
 * Native window background matching the persisted theme. The renderer shell
 * paints translucent surfaces (sidebar glass, bg-main) with no opaque
 * html/body layer, so they composite over this native value — a fixed dark
 * default tints every translucent Light surface gray (verified by pixel
 * audit: rgba(255,255,255,.55) over #141414 lands at rgb(149,149,149)).
 * Mirrors `--bg` in renderer state/theme.ts: dark #141414 / light #f8fafc.
 */
export async function resolveWindowBackground(): Promise<string> {
  try {
    const settings = await readWorkspaceSettings(app.getPath("userData"));
    const themeId = resolveThemeId(settings);
    if (themeId === "light") return "#f8fafc";
  } catch {
    // Unreadable settings keep the dark default below.
  }
  return "#141414";
}
