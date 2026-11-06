/**
 * Workspace template init — detection + file writing + git/npm orchestration.
 *
 * Split out of sessionRuntime so the pure parts (plan detection, skip-aware
 * file writes) stay unit-testable; the runner wires them to real fs, shell
 * exec and progress events. Safety contract (user-confirmed):
 *
 * - existing files are NEVER overwritten — they are skipped and reported;
 * - git init runs only when `.git` is absent, npm install only when
 *   `node_modules` is absent — and only for non-Unreal templates;
 * - npm install is cancellable and non-fatal: failure/cancel still leaves a
 *   registered workspace with all template files on disk.
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { execShellProcess } from "../tools/shellExec.js";
import {
  buildTemplateFiles,
  getWorkspaceTemplateInfo,
  isWorkspaceTemplateId,
  type WorkspaceTemplateId,
} from "../workspace/templates.js";
import type { Workspace } from "../workspace/types.js";

export type InitStepId = "folders" | "files" | "git" | "install" | "register";
export type InitStepState = "running" | "done" | "skipped" | "failed";

/** `workspace:initProgress` event payload. */
export type WorkspaceInitProgress = {
  runId: string;
  step: InitStepId;
  state: InitStepState;
  detail?: string | undefined;
};

export type InitPlanState = "will-run" | "skip-exists" | "n-a";

/** `workspace:inspectTemplateInit` reply — drives the detection rows. */
export type TemplateInitInspection = {
  git: InitPlanState;
  install: InitPlanState;
};

export type TemplateInitOutcome = {
  ok: boolean;
  cancelled: boolean;
  workspace: Workspace | null;
  written: string[];
  skipped: string[];
  gitInited: boolean;
  installRan: boolean;
  installFailed: boolean;
  error?: string;
};

/** Wall clock for `npm install` — domestic mirrors can be slow on first hit. */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

/* ------------------------------------------------------ pure helpers */

export type FsLike = {
  exists: (path: string) => boolean;
};

/**
 * Decide the git/npm steps for a folder + template. Injectable `exists` for
 * tests. Unreal (and blank) get `n-a` — those operations never run there.
 */
export function detectInitPlan(
  input: { path: string; templateId: WorkspaceTemplateId },
  fs: FsLike = { exists: (p) => existsSync(p) },
): TemplateInitInspection {
  const info = getWorkspaceTemplateInfo(input.templateId);
  if (!info.hasDeps) {
    return { git: "n-a", install: "n-a" };
  }
  return {
    git: fs.exists(join(input.path, ".git")) ? "skip-exists" : "will-run",
    install: fs.exists(join(input.path, "node_modules"))
      ? "skip-exists"
      : "will-run",
  };
}

export type WriteResult = { written: string[]; skipped: string[] };

/**
 * Write template files, skipping anything that already exists (checked
 * immediately before each write — a partial earlier run resumes cleanly).
 * Parent folders are created recursively; failures bubble as exceptions.
 */
export async function writeTemplateFiles(
  root: string,
  files: readonly { path: string; content: string }[],
  io: {
    exists?: (path: string) => boolean;
    mkdir?: (path: string) => Promise<void>;
    writeFile?: (path: string, content: string) => Promise<void>;
  } = {},
): Promise<WriteResult> {
  const exists = io.exists ?? ((p: string) => existsSync(p));
  const mk = io.mkdir ?? ((p: string) => mkdir(p, { recursive: true }));
  const write =
    io.writeFile ?? ((p: string, c: string) => writeFile(p, c, "utf8"));
  const written: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const abs = join(root, f.path);
    if (exists(abs)) {
      skipped.push(f.path);
      continue;
    }
    await mk(dirname(abs));
    await write(abs, f.content);
    written.push(f.path);
  }
  return { written, skipped };
}

/** Extract the last meaningful stdout line (npm's progress summary). */
export function lastOutputLine(stdout: string): string | null {
  const lines = stdout
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1]! : null;
}

/* ------------------------------------------------------ runner */

export type WorkspaceInitDeps = {
  /** Registers the workspace in the store (sessionRuntime.createWorkspace). */
  createWorkspace: (req: { name: string; path: string }) => Promise<Workspace>;
  /** Progress sink — index.ts wires it to `event.sender.send`. */
  emit: (progress: WorkspaceInitProgress) => void;
};

const activeRuns = new Map<string, AbortController>();

export function cancelWorkspaceTemplateInit(runId: string): boolean {
  const ctl = activeRuns.get(runId);
  if (!ctl) return false;
  ctl.abort();
  return true;
}

export type TemplateInitRequest = {
  templateId: WorkspaceTemplateId;
  name: string;
  path: string;
};

export function isTemplateInitRequest(v: unknown): v is TemplateInitRequest {
  if (typeof v !== "object" || v === null) return false;
  const req = v as { templateId?: unknown; name?: unknown; path?: unknown };
  return (
    isWorkspaceTemplateId(req.templateId) &&
    typeof req.name === "string" &&
    req.name.trim().length > 0 &&
    typeof req.path === "string" &&
    req.path.trim().length > 0
  );
}

/**
 * Full init flow. Emits progress per step; resolves with the outcome — even
 * cancelled/failed installs still register the workspace (files are on disk,
 * registering again is harmless, skipping it would strand the folder).
 */
export async function runWorkspaceTemplateInit(
  req: TemplateInitRequest,
  deps: WorkspaceInitDeps,
): Promise<TemplateInitOutcome> {
  const runId = randomUUID();
  const ctl = new AbortController();
  activeRuns.set(runId, ctl);
  const emit = (
    step: InitStepId,
    state: InitStepState,
    detail?: string | undefined,
  ) => deps.emit({ runId, step, state, detail });
  const name = req.name.trim();
  const plan = detectInitPlan(req);
  const out: TemplateInitOutcome = {
    ok: false,
    cancelled: false,
    workspace: null,
    written: [],
    skipped: [],
    gitInited: false,
    installRan: false,
    installFailed: false,
  };

  try {
    // Folders + files (one visual pair, two steps as in the demo).
    emit("folders", "running");
    const files = buildTemplateFiles(req.templateId, name);
    emit("folders", "done", `${files.length} planned`);

    emit("files", "running");
    const res = await writeTemplateFiles(req.path, files);
    out.written = res.written;
    out.skipped = res.skipped;
    emit("files", "done", `${res.written.length} written · ${res.skipped.length} skipped`);

    if (plan.git === "will-run") {
      emit("git", "running");
      const git = await execShellProcess({
        command: "git init",
        cwd: req.path,
        timeoutMs: 60_000,
        signal: ctl.signal,
      });
      if (git.status === "done" && (git.exitCode === 0 || git.exitCode === null)) {
        out.gitInited = true;
        emit("git", "done");
      } else if (git.status === "cancelled") {
        out.cancelled = true;
        emit("git", "skipped", "cancelled");
      } else {
        emit("git", "failed", git.errorMessage ?? `exit ${git.exitCode ?? "?"}`);
      }
    } else if (plan.git === "skip-exists") {
      emit("git", "skipped", "skipped — .git exists");
    } else {
      emit("git", "skipped", "n/a — Unreal");
    }

    // Install before register (demo order) but non-fatal: failure/cancel
    // still leaves the folder usable — registration below always runs.
    if (plan.install === "will-run") {
      emit("install", "running", "npm install");
      let buffered = "";
      const install = await execShellProcess({
        command: "npm install --no-fund --no-audit",
        cwd: req.path,
        timeoutMs: INSTALL_TIMEOUT_MS,
        signal: ctl.signal,
        onOutput: (chunk) => {
          buffered += chunk;
          const line = lastOutputLine(buffered.slice(-400));
          if (line) emit("install", "running", line);
        },
      });
      if (install.status === "cancelled") {
        out.cancelled = true;
        emit("install", "skipped", "cancelled — run `npm install` later");
      } else if (install.status === "done" && install.exitCode === 0) {
        out.installRan = true;
        emit("install", "done", lastOutputLine(install.stdout) ?? undefined);
      } else {
        out.installFailed = true;
        emit(
          "install",
          "failed",
          install.errorMessage ??
            lastOutputLine(install.stderr) ??
            `exit ${install.exitCode ?? "?"} — run \`npm install\` later`,
        );
      }
    } else if (plan.install === "skip-exists") {
      emit("install", "skipped", "skipped — node_modules exists");
    } else {
      emit("install", "skipped", "n/a — Unreal");
    }

    emit("register", "running");
    out.workspace = await deps.createWorkspace({ name, path: req.path });
    emit("register", "done");

    out.ok = out.workspace !== null;
    return out;
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
    return out;
  } finally {
    activeRuns.delete(runId);
  }
}
