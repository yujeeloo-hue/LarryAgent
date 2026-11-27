export type ComputerUsePlatform = "windows" | "macos";

export type MouseButton = "left" | "right" | "middle";

export type Point = { x: number; y: number };

export type Rect = { x: number; y: number; width: number; height: number };

export type ScreenInfo = Rect & {
  id: number;
  is_main: boolean;
  scale: number;
  pixels_wide: number;
  pixels_high: number;
};

export type PermissionStatus = {
  accessibility: boolean;
  screen_capture: boolean;
  hints: string[];
};

export type AppInfo = { pid: number; name: string; bundle_id: string };

export type WindowSummary = Rect & {
  title: string;
  active: boolean;
  minimized?: boolean;
};

export type UiElement = {
  role: string;
  name: string;
  frame: Rect | null;
  center?: Point;
  automation_id?: string;
  enabled?: boolean;
  protected?: boolean;
  password_present?: true;
};

export type BatchDesktopState = {
  pid: number | null;
  window: { id: string; title: string; frame: Rect } | null;
  modal: boolean;
  focused?: { role: string; name: string; automation_id?: string; protected: boolean; password_present?: true };
  hit_window_id?: string;
};

export type OcrBox = Rect & { text: string };

export type OcrLine = OcrBox & { words?: OcrBox[] };

export type ScreenLine = { text: string; frame: Rect; center: Point };

export type FrontWindow = { pid: number; title: string; frame: Rect };

export type CaptureResult = {
  path: string;
  width: number;
  height: number;
  /** Captured area in global screen coordinates. */
  rect: Rect;
};

export const PLATFORM_COORDINATES: Record<ComputerUsePlatform, string> = {
  macos: "global screen points (top-left of the main display is 0,0)",
  windows: "global physical pixels of the virtual desktop (DPI-aware; secondary displays may be negative)",
};
