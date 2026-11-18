export const IS_WINDOWS = process.platform === "win32";

export const IS_HEADLESS = process.env.JELLYBOT_HEADLESS === "1";

export const windowControlsEnabled = IS_WINDOWS;

export const loopsEnabled = true;

export const loopsDaemonManaged = false;

export const windowCaptureEnabled = !IS_WINDOWS && !IS_HEADLESS;

export const htmlToPdfEnabled = !IS_HEADLESS;

export const overlayScrollbarsForced = IS_WINDOWS;

export const trayResidentMode = IS_WINDOWS;
