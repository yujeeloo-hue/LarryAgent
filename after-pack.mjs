import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { extractFile } from "@electron/asar";
import pruneWinGpu from "./prune-win-gpu.mjs";

const execFileAsync = promisify(execFile);

export function verifyPackagedApp(archive) {
  // @electron/asar addresses entries with the CREATING platform's path.sep
  // (Filesystem.searchNodeFromDirectory splits on path.sep), and this hook
  // always runs on the same host that just wrote the archive — so normalize
  // every lookup. Without it, extractFile("out/main/index.js") splits on "\"
  // under Windows, finds no header entry, and reports a healthy archive as
  // incomplete. This guard never ran on Windows before the win build moved
  // on-host (it used to be cross-built from macOS, where "/" works).
  const read = (archivePath) => {
    try {
      const content = extractFile(archive, normalize(archivePath));
      if (!content.length) throw new Error("empty file");
      return content;
    } catch (error) {
      throw new Error(`Incomplete application package: ${archivePath} (${error.message})`);
    }
  };
  read("out/main/index.js");
  read("out/preload/index.js");
  for (const page of ["index", "changes", "reader", "subagents", "notify-popup", "usage-popup"]) {
    const pagePath = join("out", "renderer", `${page}.html`);
    const html = read(pagePath).toString("utf8");
    for (const [, reference] of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
      if (!reference.startsWith("./")) continue;
      read(join(dirname(pagePath), reference.split(/[?#]/)[0]));
    }
  }
}

export default async function afterPack(context) {
  const resources = context.electronPlatformName === "darwin"
    ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
    : join(context.appOutDir, "resources");
  // Validate the archive itself: another build can clear out/renderer while
  // electron-builder is collecting files, even when the build later succeeds.
  verifyPackagedApp(join(resources, "app.asar"));
  console.log("  • verified packaged application entry points and renderer assets");
  if (context.electronPlatformName === "win32") {
    await pruneWinGpu(context);
    return;
  }
  if (context.electronPlatformName !== "darwin") return;

  // Finder aliases carry their custom icons in a resource fork, which Git does
  // not preserve. Generate the alias immediately before electron-builder packs
  // the DMG so every build gets the yellow, functional Applications target.
  const projectDir = context.packager.projectDir;
  const tempDir = await mkdtemp(join(tmpdir(), "larry-dmg-alias-"));
  try {
    const moduleCache = join(tempDir, "module-cache");
    const executable = join(tempDir, "prepare-dmg-alias");
    await mkdir(moduleCache);
    await execFileAsync("swiftc", [
      "-module-cache-path", moduleCache,
      join(projectDir, "prepare-dmg-alias.swift"),
      "-o", executable,
    ]);
    await execFileAsync(executable, [
      join(projectDir, "build/dmg-applications-folder.png"),
      join(projectDir, "build/Applications.alias"),
    ]);
    console.log("  • prepared custom Applications alias for DMG");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
