import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// electron-builder normally makes an image-backed Finder window as large as
// the background PNG. Keep our opening window compact while the artwork has
// dark overflow for users who resize it.
const target = join(process.cwd(), "node_modules/dmg-builder/out/dmgUtil.js");
const needle = "settings.window = { position: { x: 400, y: Math.round((1440 - size.height) / 2) }, size, ...settings.window };";
const replacement = `${needle}
        // JellyBot: honor the configured opening size with an image background.
        if (specification.window != null) {
            settings.window.size = {
                width: specification.window.width ?? settings.window.size.width,
                height: specification.window.height ?? settings.window.size.height,
            };
            settings.window.position.y = Math.round((1440 - settings.window.size.height) / 2);
        }`;

const source = await readFile(target, "utf8");
if (source.includes("// JellyBot: honor the configured opening size")) {
  console.log("DMG window size patch already prepared");
} else {
  if (!source.includes(needle)) {
    throw new Error("The installed dmg-builder has changed; review the Finder window size patch");
  }
  await writeFile(target, source.replace(needle, replacement));
  console.log("Prepared compact Finder window with dark resize overflow");
}
