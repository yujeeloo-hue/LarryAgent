/**
 * Platform capability facade — the single place code asks "is this feature
 * available on this OS" (Windows v1: docs/plans/20260907-jellybot-windows-v1.md).
 *
 * macOS behavior must stay byte-identical: every gate below is true on darwin;
 * gates only ever narrow behavior on win32 and in the headless agentd node
 * (JELLYBOT_HEADLESS=1, see IS_HEADLESS below). Zero imports so main, tools
 * and renderer can all depend on it without cycles.
 */
export const IS_WINDOWS = process.platform === "win32";

/**
 * Headless jellybot-agentd process: no Electron shell, no windows, no
 * native helpers. Set by the agentd launcher / systemd unit
 * (JELLYBOT_HEADLESS=1) before any feature module reads these gates.
 */
export const IS_HEADLESS = process.env.JELLYBOT_HEADLESS === "1";

/** Self-drawn caption buttons (min/max/close) + window-controls IPC. macOS keeps native traffic lights. */
export const windowControlsEnabled = IS_WINDOWS;

/** Legacy navigation capability key; the entry now opens Coco on every platform. */
export const loopsEnabled = true;

/** Independent launchd scheduling is retired; Coco belongs to the application. */
export const loopsDaemonManaged = false;

/**
 * macOS window-capture Swift helper — no Windows or headless equivalent
 * in v1.
 */
export const windowCaptureEnabled = !IS_WINDOWS && !IS_HEADLESS;

/**
 * HTML/Markdown → PDF export (convert_to_pdf tool). Needs an Electron
 * BrowserWindow to print — not registered in the headless agentd node.
 */
export const htmlToPdfEnabled = !IS_HEADLESS;

/**
 * Slim auto-hiding overlay scrollbars. Native on macOS; on Windows Chromium
 * otherwise falls back to chunky classic bars that permanently consume ~15px
 * of layout, so the main process force-enables the overlay-scrollbar feature
 * flag there. The switch is never appended on darwin — macOS keeps its
 * native scrollbar presentation byte-identical.
 */
export const overlayScrollbarsForced = IS_WINDOWS;

/**
 * Resident / background mode: on Windows the close button hides the window
 * to a tray icon instead of quitting (true exit lives in the tray's Quit
 * item). macOS keeps native close semantics untouched.
 */
export const trayResidentMode = IS_WINDOWS;
