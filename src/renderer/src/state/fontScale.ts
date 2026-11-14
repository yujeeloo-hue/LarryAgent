/**
 * FontScale — Settings → Appearance → Text size applied to the live window.
 *
 * Two independent knobs:
 * - **Interface text** (`ui`): whole-window zoom via the preload webFrame
 *   bridge (VS Code `window.zoomLevel` semantics — the viewport's CSS px
 *   shrink, so no stray scrollbars and editor content stays consistent).
 *   Applied per window; the fixed-size popups (usage/notify) skip it.
 * - **Conversation text** (`chat`): the `--chat-fs-scale` CSS variable on
 *   <html>. The conversation stylesheet multiplies its single-source bases
 *   by it (msg body 14px, md-table 13px, `--diff-fs` 12px, composer 13px);
 *   the em-based markdown hierarchy scales for free. Tool-card labels and
 *   meta text deliberately do NOT consume the variable (pinned geometries).
 *
 * Mirrors themeManager: applied locally on save, bootstrapped per window,
 * and broadcast to secondary windows via `settings:appearanceChanged`.
 */

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

/** Apply one or both scales; omitted knobs keep their current value. */
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
    // Keep the default implicit so stylesheets fall to their static values.
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

/** Last applied scales (default 1/1 before bootstrap). */
export function readFontScales(): FontScales {
  return { ...current };
}

/**
 * Apply the persisted scales on window load. Failures degrade to 1/1 —
 * stylesheets render default sizes without any JS.
 */
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
