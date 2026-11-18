import { spawn } from "node:child_process";
import { agentLogInfo, agentLogWarn } from "../../logging/agentLog.js";
import { findClangdBinary, pathExists } from "./locate.js";

export type ClangdInstallResult = { ok: true; path: string } | { ok: false; message: string };

export const WINGET_LLVM_ARGS = [
  "install",
  "--id",
  "LLVM.LLVM",
  "--exact",
  "--source",
  "winget",
  "--accept-source-agreements",
  "--accept-package-agreements",
];

const WINGET_NO_APPLICABLE_UPGRADE = 0x8a15002b;

export const BREW_LLVM_ARGS = ["install", "llvm"];

export function installSucceeded(exitCode: number): boolean {
  return exitCode === 0 || exitCode >>> 0 === WINGET_NO_APPLICABLE_UPGRADE;
}

export const MANUAL_INSTALL_HINT =
  process.platform === "darwin"
    ? "Install the latest LLVM with Homebrew (brew install llvm), or install Xcode."
    : "Install the latest LLVM (winget install LLVM.LLVM) or from https://github.com/llvm/llvm-project/releases.";

function run(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: false, stdio: "ignore" });
    child.on("error", () => resolve(-1));
    child.on("exit", (code) => resolve(code ?? -1));
  });
}

function brewCommand(): string {
  return ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(pathExists) ?? "brew";
}

export async function installLatestClangd(): Promise<ClangdInstallResult> {
  const command =
    process.platform === "win32" ? "winget" : process.platform === "darwin" ? brewCommand() : null;
  if (!command) return { ok: false, message: MANUAL_INSTALL_HINT };
  const args = process.platform === "win32" ? WINGET_LLVM_ARGS : BREW_LLVM_ARGS;
  agentLogInfo("clangd.install_start", { command, args });
  const exitCode = await run(command, args);
  const path = findClangdBinary();
  if (path && installSucceeded(exitCode)) {
    agentLogInfo("clangd.install_done", { exitCode, path });
    return { ok: true, path };
  }
  agentLogWarn("clangd.install_failed", { exitCode });
  return {
    ok: false,
    message:
      exitCode === -1
        ? `${command} is not available. ${MANUAL_INSTALL_HINT}`
        : `Installing LLVM failed (exit ${exitCode}). ${MANUAL_INSTALL_HINT}`,
  };
}
