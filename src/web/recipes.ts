import { basename, join, posix, win32 } from "node:path";
import { copyDebuggeeEnv } from "../debug/debuggeeEnv.js";
import type { WebLaunchContext } from "./launchContext.js";

export type WebPorts = {
  inspectPort: number;
  remoteDebugPort: number;
};

export type WebSpawnPlan = {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  shell: boolean;
};

export type WebSpawnPlanOpts = {
  platform?: NodeJS.Platform;
  sourceEnv?: NodeJS.ProcessEnv;
  home?: string;
};

function inspectFlag(port: number, stopOnEntry: boolean): string {
  const kind = stopOnEntry ? "inspect-brk" : "inspect";
  return `--${kind}=127.0.0.1:${port}`;
}

function isNodeRuntime(executable: string): boolean {
  const base = basename(executable).replace(/\.exe$/i, "").toLowerCase();
  return base === "node" || base === "nodejs" || base === "tsx" || base === "ts-node";
}

function hasInspect(args: string[], env: Record<string, string>): boolean {
  if (/\b--inspect(-brk)?\b/.test(env.NODE_OPTIONS ?? "")) return true;
  return args.some(
    (arg) =>
      arg === "--inspect" ||
      arg === "--inspect-brk" ||
      arg.startsWith("--inspect=") ||
      arg.startsWith("--inspect-brk="),
  );
}

function withInspectEnv(
  env: Record<string, string>,
  port: number,
  stopOnEntry: boolean,
): void {
  const flag = inspectFlag(port, stopOnEntry);
  const prev = env.NODE_OPTIONS?.trim();
  env.NODE_OPTIONS = prev ? `${prev} ${flag}` : flag;
}

const SHELL_METACHARS = /[&|;<>()$`"'*?\\\n\r]/;

/**
 * `npm run dev` + `--inspect` in NODE_OPTIONS makes every node in the tree
 * bind the same inspector port — the npm CLI grabs it first, so the real
 * server (e.g. `node --watch server.js`) never gets one and the debugger
 * ends up attached to npm. When the script is a plain `node args…` command
 * we can spawn node directly and pass `--inspect` as an argument instead:
 * watch children inherit it cleanly and nothing else binds it.
 */
export function directNodeScript(
  scriptValue: string,
): { executable: "node"; args: string[] } | null {
  const tokens = scriptValue.trim().split(/\s+/);
  if (tokens.length < 2) return null;
  const base = basename(tokens[0]!).replace(/\.exe$/i, "").toLowerCase();
  if (base !== "node" && base !== "nodejs") return null;
  const args = tokens.slice(1);
  if (args.some((arg) => SHELL_METACHARS.test(arg))) return null;
  return { executable: "node", args };
}

function cmdNeedsShell(executable: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  return /\.cmd$/i.test(executable);
}

export function packageRunner(
  projectRoot: string,
  exists: (path: string) => boolean,
  platform: NodeJS.Platform = process.platform,
): { executable: string; argsFor: (script: string) => string[] } {
  const win = platform === "win32";
  if (exists(join(projectRoot, "pnpm-lock.yaml"))) {
    return {
      executable: win ? "pnpm.cmd" : "pnpm",
      argsFor: (script) => ["run", script],
    };
  }
  if (exists(join(projectRoot, "yarn.lock"))) {
    return {
      executable: win ? "yarn.cmd" : "yarn",
      argsFor: (script) => ["run", script],
    };
  }
  if (exists(join(projectRoot, "bun.lock")) || exists(join(projectRoot, "bun.lockb"))) {
    return {
      executable: "bun",
      argsFor: (script) => ["run", script],
    };
  }
  return {
    executable: win ? "npm.cmd" : "npm",
    argsFor: (script) => ["run", script],
  };
}

export function defaultWebRoot(
  projectRoot: string,
  exists: (path: string) => boolean,
): string {
  for (const rel of [
    "apps/web",
    "packages/web",
    "client",
    "frontend",
    "web",
    "src/web",
    "src/frontend",
    "src/client",
  ]) {
    const path = join(projectRoot, ...rel.split("/"));
    if (exists(path)) return path;
  }
  return projectRoot;
}

/** Isolated Chromium profile so debug Chrome can run next to the user's browser. */
export function chromeDebugUserDataDir(projectRoot: string): string {
  return join(projectRoot, ".larry", "chrome-debug-profile");
}

export function webServerSpawnPlan(
  context: WebLaunchContext,
  ports: WebPorts,
  platformOrOpts: NodeJS.Platform | WebSpawnPlanOpts = process.platform,
): WebSpawnPlan {
  const opts: WebSpawnPlanOpts =
    typeof platformOrOpts === "string" ? { platform: platformOrOpts } : platformOrOpts;
  const platform = opts.platform ?? process.platform;
  const env = copyDebuggeeEnv(opts.sourceEnv ?? process.env, {
    platform,
    ...(opts.home ? { home: opts.home } : {}),
  });
  env.JELLYBOT_DEBUGGEE = "1";
  let args = [...context.runtimeArgs];
  const executable = context.runtimeExecutable;
  if (isNodeRuntime(executable)) {
    if (!hasInspect(args, env)) {
      args = [inspectFlag(ports.inspectPort, context.stopOnEntry), ...args];
    }
  } else if (!hasInspect(args, env)) {
    withInspectEnv(env, ports.inspectPort, context.stopOnEntry);
  }
  const shell = context.shell || cmdNeedsShell(executable, platform);
  if (context.pathPrepend?.length) {
    // Keep `npm run` semantics for scripts that shell out to local bins.
    const key =
      Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
    const separator = platform === "win32" ? win32.delimiter : posix.delimiter;
    const dirs = context.pathPrepend.join(separator);
    env[key] = env[key] ? `${dirs}${separator}${env[key]}` : dirs;
  }
  return {
    executable,
    args,
    cwd: context.projectRoot,
    env,
    shell,
  };
}

export function chromeSpawnPlan(
  chromeBin: string,
  url: string,
  remoteDebugPort: number,
  projectRoot: string,
  opts?: WebSpawnPlanOpts,
): WebSpawnPlan {
  const platform = opts?.platform ?? process.platform;
  const env = copyDebuggeeEnv(opts?.sourceEnv ?? process.env, {
    platform,
    ...(opts?.home ? { home: opts.home } : {}),
  });
  return {
    executable: chromeBin,
    args: [
      `--remote-debugging-port=${remoteDebugPort}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${chromeDebugUserDataDir(projectRoot)}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-sync",
      // Host Electron's crashpad pipe must not be reused — on macOS that
      // aborts Larry Agent when this Chrome starts.
      "--disable-crash-reporter",
      "--disable-breakpad",
      url,
    ],
    cwd: projectRoot,
    env,
    shell: false,
  };
}
