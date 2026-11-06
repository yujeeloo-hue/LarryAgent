import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  copyDebuggeeEnv,
  resolveNodeFromPath,
} from "../debug/debuggeeEnv.js";
import type { ElectronLaunchContext } from "./launchContext.js";

export { unixPathWithNodeLookup } from "../debug/debuggeeEnv.js";

export type ElectronPorts = {
  inspectPort: number;
  remoteDebugPort: number;
};

export type ElectronSpawnPlan = {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  shell: boolean;
};

export type ElectronSpawnPlanOpts = {
  platform?: NodeJS.Platform;
  sourceEnv?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
};

function hasFlag(args: string[], name: string): boolean {
  const prefix = `${name}=`;
  return args.some((arg) => arg === name || arg.startsWith(prefix));
}

function inspectFlag(port: number, stopOnEntry: boolean): string {
  const kind = stopOnEntry ? "inspect-brk" : "inspect";
  return `--${kind}=127.0.0.1:${port}`;
}

/**
 * electron-vite's `--inspect [port]` is boolean | number. A host:port string
 * (or even `--inspect=9229` as a string) makes the CLI fall back to 5858.
 * The child Electron spawn reads `V8_INSPECTOR_PORT` instead.
 */
function stripInspectArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--inspect" || arg === "--inspect-brk") {
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) i += 1;
      continue;
    }
    if (arg.startsWith("--inspect=") || arg.startsWith("--inspect-brk=")) continue;
    out.push(arg);
  }
  return out;
}

/** Isolated Chromium profile so a second copy can run next to the debugger host. */
export function electronDebugUserDataDir(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === "win32" ? win32 : posix;
  return paths.join(projectRoot, ".larry", "electron-debug-profile");
}

function debuggeeCliArgs(projectRoot: string, platform: NodeJS.Platform): string[] {
  return [
    "--remote-allow-origins=*",
    `--user-data-dir=${electronDebugUserDataDir(projectRoot, platform)}`,
  ];
}

export function electronViteCliJs(
  projectRoot: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === "win32" ? win32 : posix;
  return paths.join(projectRoot, "node_modules", "electron-vite", "bin", "electron-vite.js");
}

/**
 * argv/env for spawning the Electron debuggee.
 * `electron-vite` gets inspector ports via env (`V8_INSPECTOR_PORT` +
 * `REMOTE_DEBUGGING_PORT`). Classic Electron gets Chromium switches on argv.
 */
export function electronSpawnPlan(
  context: ElectronLaunchContext,
  ports: ElectronPorts,
  platformOrOpts: NodeJS.Platform | ElectronSpawnPlanOpts = process.platform,
): ElectronSpawnPlan {
  const opts: ElectronSpawnPlanOpts =
    typeof platformOrOpts === "string" ? { platform: platformOrOpts } : platformOrOpts;
  const platform = opts.platform ?? process.platform;
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;
  const env = copyDebuggeeEnv(opts.sourceEnv ?? process.env, {
    platform,
    home,
  });
  env.REMOTE_DEBUGGING_PORT = String(ports.remoteDebugPort);
  env.JELLYBOT_DEBUGGEE = "1";

  let args = [...context.runtimeArgs];
  const cliExtra = debuggeeCliArgs(context.projectRoot, platform);
  if (context.recipe === "electron-vite") {
    args = stripInspectArgs(args);
    if (context.stopOnEntry) {
      env.V8_INSPECTOR_BRK_PORT = String(ports.inspectPort);
      delete env.V8_INSPECTOR_PORT;
    } else {
      env.V8_INSPECTOR_PORT = String(ports.inspectPort);
      delete env.V8_INSPECTOR_BRK_PORT;
    }
    env.ELECTRON_CLI_ARGS = JSON.stringify(cliExtra);
  } else {
    const inspect = inspectFlag(ports.inspectPort, context.stopOnEntry);
    if (!hasFlag(args, "--inspect") && !hasFlag(args, "--inspect-brk")) {
      args.push(inspect);
    }
    if (!hasFlag(args, "--remote-debugging-port")) {
      args.push(`--remote-debugging-port=${ports.remoteDebugPort}`);
    }
    for (const flag of cliExtra) {
      const name = flag.split("=")[0]!;
      if (!hasFlag(args, name)) args.push(flag);
    }
  }

  let executable = context.runtimeExecutable;
  const shell = platform === "win32" && /\.cmd$/i.test(executable);
  if (context.recipe === "electron-vite" && platform !== "win32") {
    const cli = electronViteCliJs(context.projectRoot, platform);
    const node = resolveNodeFromPath(env.PATH ?? "", exists, platform);
    if (node && exists(cli)) {
      args = [cli, ...args];
      executable = node;
    }
  }
  return {
    executable,
    args,
    cwd: context.projectRoot,
    env,
    shell,
  };
}

export function viteBinName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "electron-vite.cmd" : "electron-vite";
}

export function electronDistBinary(
  projectRoot: string,
  platform: NodeJS.Platform,
): string {
  if (platform === "win32") {
    return join(projectRoot, "node_modules", "electron", "dist", "electron.exe");
  }
  if (platform === "darwin") {
    return join(
      projectRoot,
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
      "Contents",
      "MacOS",
      "Electron",
    );
  }
  return join(projectRoot, "node_modules", "electron", "dist", "electron");
}

export function viteBinPath(projectRoot: string, platform: NodeJS.Platform): string {
  return join(projectRoot, "node_modules", ".bin", viteBinName(platform));
}

export function defaultRuntimeArgs(
  recipe: ElectronLaunchContext["recipe"],
  main: string | null,
): string[] {
  if (recipe === "electron-vite") return ["dev", "--sourcemap"];
  return [main?.trim() || "."];
}

/** Directory that should exist for source-map `webRoot` (renderer). */
export function defaultWebRoot(projectRoot: string, exists: (p: string) => boolean): string {
  const renderer = join(projectRoot, "src", "renderer");
  return exists(renderer) ? renderer : projectRoot;
}

export function defaultOutFiles(projectRoot: string): string[] {
  return [join(projectRoot, "out", "**", "*.js")];
}
