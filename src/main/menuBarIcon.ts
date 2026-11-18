import { app, Tray, nativeImage } from "electron";
import { join } from "node:path";
import type { TrayHostDeps, UsagePopupController } from "./usagePopup.js";


export const MENUBAR_ACTION_CHANNEL = "menubar:action";

export type MenubarAction = "new-task" | "loop" | "settings";

let tray: Tray | undefined;

function resolveMenubarDir(): string {
  const base = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "resources");
  return join(base, "menubar");
}

function loadTemplateImage(dir: string, name: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(join(dir, `${name}.png`));
  const retina = nativeImage.createFromPath(join(dir, `${name}@2x.png`));
  if (!retina.isEmpty()) {
    image.addRepresentation({ scaleFactor: 2, buffer: retina.toBitmap() });
  }
  image.setTemplateImage(true);
  return image;
}

export function setupMenuBarBrandItem(
  deps: TrayHostDeps,
  usagePopup: UsagePopupController,
): boolean {
  if (process.platform !== "darwin") return false;
  if (tray) return true;
  try {
    const dir = resolveMenubarDir();
    const dogHead = loadTemplateImage(dir, "dogHeadTemplate");
    if (dogHead.isEmpty()) {
      console.error("[menubar] dogHeadTemplate.png missing — no menu bar item");
      return false;
    }
    tray = new Tray(dogHead);
    tray.setToolTip("Larry Agent");
    tray.on("click", () => {
      if (!tray) return;
      if (!deps.isMainWindowOpen()) {
        deps.openMainWindow();
        return;
      }
      usagePopup.toggle(tray.getBounds());
    });
    tray.on("right-click", () => {
      if (!tray) return;
      usagePopup.toggle(tray.getBounds());
    });
    return true;
  } catch (err) {
    console.error("[menubar] create failed", err);
    tray = undefined;
    return false;
  }
}

