import { readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "./atomicJson.js";
import { performAgentdUpdate, defaultInstallDir, type AgentdUpdateOutcome, type AgentdUpdateStepEvent } from "./update.js";
import {
  DEFAULT_DATA_DIR,
  resolveAgentdUpdateQueueDir,
  resolveAgentdUpdateStatusDir,
} from "./config.js";

export interface UpdateRequest {
  id: string;
  source: string;
  sha256?: string;
  force?: boolean;
}

const MAX_LOG_LINES = 40;

function defaultOut(message: string): void {
  process.stdout.write(`${message}\n`);
}

function isHex64(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function validateRequest(raw: unknown, dataDir: string): { ok: true; request: UpdateRequest } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object") return { ok: false, error: "request is not an object" };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  const source = typeof r.source === "string" ? r.source.trim() : "";
  if (!id || !source) return { ok: false, error: "request needs id + source" };
  if (/^https:\/\//i.test(source)) {
    if (typeof r.sha256 !== "string" || !isHex64(r.sha256)) {
      return { ok: false, error: "https sources must pin a 64-hex sha256" };
    }
    return { ok: true, request: { id, source, sha256: r.sha256, force: r.force === true } };
  }
  if (/^http:\/\//i.test(source)) {
    return { ok: false, error: "plain-http sources are not allowed (https only)" };
  }
  if (!source.startsWith("/")) return { ok: false, error: "local sources must be absolute paths" };
  const allowedRoots = [dataDir, "/srv/jellybot-agent", "/tmp"];
  let resolved: string;
  try {
    resolved = realpathSync(source);
  } catch {
    return { ok: false, error: `file not found: ${source}` };
  }
  const underRoot = allowedRoots.some((root) => {
    let resolvedRoot = root;
    try {
      resolvedRoot = realpathSync(root);
    } catch {
    }
    return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}/`);
  });
  if (!underRoot) {
    return { ok: false, error: `local source must live under ${allowedRoots.join(", ")}` };
  }
  return { ok: true, request: { id, source: resolved, force: r.force === true } };
}

export async function runUpdaterWorker(
  options: { dataDir?: string; out?: (message: string) => void } = {},
): Promise<number> {
  const dataDir = options.dataDir ?? (process.env.JELLYBOT_AGENTD_DATA_DIR?.trim() || DEFAULT_DATA_DIR);
  const out = options.out ?? defaultOut;
  const envOverridden = dataDir !== DEFAULT_DATA_DIR;
  const queueDir = resolveAgentdUpdateQueueDir(dataDir);
  const statusDir = resolveAgentdUpdateStatusDir(dataDir);
  const statusFile = join(statusDir, "current.json");
  const installDir = defaultInstallDir();

  if (process.getuid?.() !== 0 && !envOverridden) {
    out("✖ process-update-queue must run as root (systemd jellybot-agentd-update.service)");
    out("  dev/test: set JELLYBOT_AGENTD_DATA_DIR to a scratch dir to run unprivileged");
    return 1;
  }

  await mkdir(statusDir, { recursive: true });
  let processed = 0;

  for (;;) {
    const requestPath = join(queueDir, "request.json");
    let raw: string;
    try {
      raw = readFileSync(requestPath, "utf8");
    } catch {
      break;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      out("✖ request.json is not valid JSON — dropping it");
      await writeJsonAtomic(statusFile, {
        phase: "failed",
        error: "queued request was not valid JSON",
        ts: Date.now(),
      });
      rmSync(requestPath, { force: true });
      break;
    }
    const validated = validateRequest(parsed, dataDir);
    if (!validated.ok) {
      out(`✖ rejecting request: ${validated.error}`);
      await writeJsonAtomic(statusFile, {
        phase: "failed",
        error: `request rejected: ${validated.error}`,
        ts: Date.now(),
      });
      rmSync(requestPath, { force: true });
      break;
    }
    const request = validated.request;
    processed += 1;
    const logLines: string[] = [];
    out(`[${request.id}] update from ${request.source}${request.force ? " (force)" : ""}`);

    let statusChain = Promise.resolve();
    const publish = (value: unknown): void => {
      statusChain = statusChain.then(() => writeJsonAtomic(statusFile, value)).catch((error) => {
        out(`⚠ status write failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    };
    let lastStep: AgentdUpdateStepEvent | undefined;
    const stepFields = () =>
      lastStep
        ? { step: lastStep.step, ...(lastStep.progress ? { progress: { ...lastStep.progress } } : {}) }
        : {};
    const runningState = () => ({
      phase: "running" as const,
      id: request.id,
      source: request.source,
      ...stepFields(),
      ...(logLines.length > 0 ? { logTail: logLines.slice(-8).join("\n") } : {}),
      ts: Date.now(),
    });
    let outcome: AgentdUpdateOutcome = { ok: false, error: "update did not run" };
    try {
      publish(runningState());
      try {
        outcome = await performAgentdUpdate({
          source: request.source,
          sha256: request.sha256,
          force: request.force,
          installDir,
          write: (line) => {
            out(line);
            logLines.push(line);
            if (logLines.length > MAX_LOG_LINES) logLines.shift();
            publish(runningState());
          },
          onStep: (event) => {
            lastStep = event;
            publish(runningState());
          },
        });
      } catch (error) {
        outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (outcome.ok) {
        publish({
          phase: "done",
          id: request.id,
          source: request.source,
          version: outcome.version,
          logTail: logLines.slice(-8).join("\n"),
          ts: Date.now(),
        });
        out(`[${request.id}] ✔ installed ${outcome.version}`);
      } else {
        publish({
          phase: "failed",
          id: request.id,
          source: request.source,
          error: outcome.error,
          ...stepFields(),
          logTail: logLines.slice(-8).join("\n"),
          ts: Date.now(),
        });
        out(`[${request.id}] ✖ ${outcome.error}`);
      }
      await statusChain;
    } finally {
      rmSync(requestPath, { force: true });
    }
  }

  try {
    for (const name of readdirSync(queueDir)) {
      if (name.startsWith(".request-") || name === ".probe") rmSync(join(queueDir, name), { force: true });
    }
  } catch {
  }
  out(processed ? `queue drained (${processed} request${processed === 1 ? "" : "s"})` : "queue empty");
  return 0;
}
