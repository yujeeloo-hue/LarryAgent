/**
 * Resolve everything needed to launch a Node server + Chrome under the debugger.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findUproject } from "../unreal/uproject.js";
import { findElectronManifest } from "../electron/manifest.js";
import { findChromeBinary } from "./chromeBinary.js";
import {
  readWebDebugConfig,
  type WebDebugOverride,
} from "./debugConfig.js";
import { findWebManifest } from "./manifest.js";
import {
  defaultWebRoot,
  directNodeScript,
  packageRunner,
} from "./recipes.js";

export type WebLaunchContext = {
  projectRoot: string;
  manifestPath: string;
  packageName: string;
  webRoot: string;
  runtimeExecutable: string;
  runtimeArgs: string[];
  /** Extra PATH entries in front (e.g. `node_modules/.bin` for npm parity). */
  pathPrepend?: string[];
  shell: boolean;
  stopOnEntry: boolean;
  pageUrl: string | null;
  chromeBin: string | null;
};

export type WebLaunchErrorCode =
  | "not_web"
  | "unreal_project"
  | "electron_project"
  | "no_server_script"
  | "bad_debug_config";

export type WebLaunchResult =
  | { ok: true; context: WebLaunchContext }
  | { ok: false; code: WebLaunchErrorCode; message: string };

export type ResolveWebLaunchOpts = {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  findChrome?: (opts: {
    platform: NodeJS.Platform;
    exists: (path: string) => boolean;
  }) => string | null;
  readDebugConfig?: (workspacePath: string) => Promise<
    | { ok: true; web: WebDebugOverride | null }
    | { ok: false; message: string }
  >;
};

function scriptValueFromManifest(
  manifestPath: string,
  script: string,
): string | null {
  try {
    const pkg = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const value = pkg.scripts?.[script];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

export async function resolveWebLaunchContext(
  workspacePath: string,
  opts?: ResolveWebLaunchOpts,
): Promise<WebLaunchResult> {
  const os = opts?.platform ?? process.platform;
  const exists = opts?.exists ?? ((path: string) => existsSync(path));
  if (findUproject(workspacePath)) {
    return {
      ok: false,
      code: "unreal_project",
      message: "Unreal project takes precedence over web debug in this workspace",
    };
  }
  if (findElectronManifest(workspacePath)) {
    return {
      ok: false,
      code: "electron_project",
      message: "Electron app takes precedence over web debug in this workspace",
    };
  }
  const hit = findWebManifest(workspacePath);
  if (!hit) {
    return {
      ok: false,
      code: "not_web",
      message: "No Node web app (package.json with a server or page) found in this workspace",
    };
  }

  const debugFile = await (opts?.readDebugConfig ?? readWebDebugConfig)(workspacePath);
  if (!debugFile.ok) {
    return { ok: false, code: "bad_debug_config", message: debugFile.message };
  }
  const over = debugFile.web;
  const runner = packageRunner(hit.projectRoot, exists, os);
  let runtimeExecutable: string;
  let runtimeArgs: string[];
  let pathPrepend: string[] | undefined;
  let shell = false;
  if (over?.server?.trim()) {
    runtimeExecutable = over.server.trim();
    runtimeArgs = [];
    shell = true;
  } else if (over?.runtimeExecutable) {
    runtimeExecutable = over.runtimeExecutable;
    runtimeArgs = over.runtimeArgs ?? [];
  } else {
    const script = over?.script ?? hit.script;
    if (!script) {
      return {
        ok: false,
        code: "no_server_script",
        message: `No start/dev/server script in ${hit.manifestPath} — set web.server or web.script in .larry/debug.json`,
      };
    }
    runtimeExecutable = runner.executable;
    runtimeArgs = over?.runtimeArgs ?? runner.argsFor(script);
    if (!over?.runtimeArgs) {
      const direct = directNodeScript(
        scriptValueFromManifest(hit.manifestPath, script) ?? "",
      );
      if (direct) {
        // npm's own node process would grab the inspector port when --inspect
        // rides NODE_OPTIONS — spawn the server's node directly instead.
        runtimeExecutable = direct.executable;
        runtimeArgs = direct.args;
        pathPrepend = [join(hit.projectRoot, "node_modules", ".bin")];
      }
    }
  }

  const chromeBin =
    over?.chromeExecutable && exists(over.chromeExecutable)
      ? over.chromeExecutable
      : (opts?.findChrome ?? findChromeBinary)({ platform: os, exists });

  return {
    ok: true,
    context: {
      projectRoot: hit.projectRoot,
      manifestPath: hit.manifestPath,
      packageName: hit.packageName,
      webRoot: over?.webRoot ?? defaultWebRoot(hit.projectRoot, exists),
      runtimeExecutable,
      runtimeArgs,
      ...(pathPrepend ? { pathPrepend } : {}),
      shell,
      stopOnEntry: over?.stopOnEntry === true,
      pageUrl: over?.url ?? null,
      chromeBin,
    },
  };
}
