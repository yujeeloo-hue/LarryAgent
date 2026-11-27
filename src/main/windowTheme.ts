import { app } from "electron";
import { readWorkspaceSettings } from "../settings/index.js";
import { resolveThemeId } from "../settings/types.js";

export async function resolveWindowBackground(): Promise<string> {
  try {
    const settings = await readWorkspaceSettings(app.getPath("userData"));
    const themeId = resolveThemeId(settings);
    if (themeId === "light") return "#f8fafc";
  } catch {
  }
  return "#141414";
}
