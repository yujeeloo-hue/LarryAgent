/**
 * On-demand clangd download (P3): fetch the standalone clangd zip into
 * `%LOCALAPPDATA%\JellyBot\tools\clangd\` and extract it with PowerShell.
 * Pinned URL — the GitHub API is rate-limited on shared egress IPs, direct
 * release URLs are not.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { agentLogWarn } from "../../logging/agentLog.js";

export const CLANGD_ZIP_VERSION = "19.1.2";
const CLANGD_ZIP_URL = `https://github.com/clangd/clangd/releases/download/${CLANGD_ZIP_VERSION}/clangd-windows-${CLANGD_ZIP_VERSION}.zip`;

export function downloadedClangdPath(): string {
  return join(
    process.env.LOCALAPPDATA ?? "",
    "JellyBot",
    "tools",
    "clangd",
    `clangd_${CLANGD_ZIP_VERSION}`,
    "bin",
    "clangd.exe",
  );
}

export function isClangdDownloaded(): boolean {
  try {
    accessSync(downloadedClangdPath(), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Download + extract. Resolves with the clangd.exe path. Windows-only
 * (the service itself is Windows/macOS; the zip is windows-x64).
 */
export async function downloadClangd(): Promise<
  { ok: true; path: string } | { ok: false; message: string }
> {
  if (process.platform !== "win32") {
    return { ok: false, message: "Automatic download is Windows-only; install LLVM or clangd manually." };
  }
  if (isClangdDownloaded()) {
    return { ok: true, path: downloadedClangdPath() };
  }
  const targetDir = join(process.env.LOCALAPPDATA ?? "", "JellyBot", "tools", "clangd");
  const zipPath = join(targetDir, `clangd-windows-${CLANGD_ZIP_VERSION}.zip`);
  try {
    mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return { ok: false, message: `Could not create ${targetDir}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Net.ServicePointManager]::SecurityProtocol='Tls12'",
    `Invoke-WebRequest -Uri '${CLANGD_ZIP_URL}' -OutFile '${zipPath}'`,
    `Expand-Archive -Path '${zipPath}' -DestinationPath '${targetDir}' -Force`,
    "Remove-Item '${zipPath}' -ErrorAction SilentlyContinue",
  ].join("; ");
  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-Command", script],
      { windowsHide: true, stdio: "ignore" },
    );
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0 || !isClangdDownloaded()) {
    agentLogWarn("clangd.download_failed", { exitCode });
    return {
      ok: false,
      message:
        "Download/extract failed. Install LLVM (winget install LLVM.LLVM) or " +
        `extract ${CLANGD_ZIP_URL} into ${targetDir} manually.`,
    };
  }
  return { ok: true, path: downloadedClangdPath() };
}
