
export const CHAT_FONT_SCALE_VAR = "--chat-fs-scale";

export const UI_FONT_SCALE_MIN = 0.8;
export const UI_FONT_SCALE_MAX = 1.5;
export const CHAT_FONT_SCALE_MIN = 0.8;
export const CHAT_FONT_SCALE_MAX = 1.6;

export interface FontScales {
  ui: number;
  chat: number;
}

let current: FontScales = { ui: 1, chat: 1 };

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(min, value));
}

export function applyFontScales(scales: {
  ui?: number;
  chat?: number;
}): void {
  if (scales.ui !== undefined) {
    current.ui = clamp(scales.ui, UI_FONT_SCALE_MIN, UI_FONT_SCALE_MAX);
    window.jellybot?.setUiZoomFactor?.(current.ui);
  }
  if (scales.chat !== undefined) {
    current.chat = clamp(
      scales.chat,
      CHAT_FONT_SCALE_MIN,
      CHAT_FONT_SCALE_MAX,
    );
    if (current.chat === 1) {
      document.documentElement.style.removeProperty(CHAT_FONT_SCALE_VAR);
    } else {
      document.documentElement.style.setProperty(
        CHAT_FONT_SCALE_VAR,
        String(current.chat),
      );
    }
  }
}

export function readFontScales(): FontScales {
  return { ...current };
}

export async function bootstrapFontScaleFromSettings(): Promise<void> {
  try {
    const settings = await window.jellybot?.getWorkspaceSettings?.();
    if (settings) {
      applyFontScales({
        ui: settings.uiFontScale ?? 1,
        chat: settings.chatFontScale ?? 1,
      });
    }
  } catch (error) {
    console.error("[renderer] failed to bootstrap font scales", error);
  }
}
