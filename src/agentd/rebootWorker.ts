/**
 * `agentd process-reboot-queue` — the ROOT side of remote reboot.
 *
 * The agent service runs with NoNewPrivileges, so `sudo` from that process
 * cannot work. The console writes update-queue/reboot.json; this oneshot
 * (jellybot-agentd-reboot.service) deletes that file and then reboots.
 * Deleting first is what stops a leftover file from rebooting again on the
 * way back up.
 */
import { readFileSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { writeJsonAtomic } from "./atomicJson.js";
import {
  DEFAULT_DATA_DIR,
  resolveAgentdUpdateQueueDir,
  resolveAgentdUpdateStatusDir,
} from "./config.js";

function defaultOut(message: string): void {
  process.stdout.write(`${message}\n`);
}

export async function runRebootWorker(options: {
  dataDir?: string;
  spawnFn?: typeof spawnSync;
  out?: (message: string) => void;
} = {}): Promise<number> {
  const dataDir = options.dataDir ?? (process.env.JELLYBOT_AGENTD_DATA_DIR?.trim() || DEFAULT_DATA_DIR);
  const out = options.out ?? defaultOut;
  const envOverridden = dataDir !== DEFAULT_DATA_DIR;
  const spawnFn = options.spawnFn ?? spawnSync;
  const queueDir = resolveAgentdUpdateQueueDir(dataDir);
  const statusFile = join(resolveAgentdUpdateStatusDir(dataDir), "current.json");
  const requestPath = join(queueDir, "reboot.json");

  if (process.getuid?.() !== 0 && !envOverridden) {
    out("✖ process-reboot-queue must run as root (systemd jellybot-agentd-reboot.service)");
    return 1;
  }

  let raw: string;
  try {
    raw = readFileSync(requestPath, "utf8");
  } catch {
    out("queue empty");
    return 0;
  }

  await mkdir(resolveAgentdUpdateStatusDir(dataDir), { recursive: true });

  let id = "";
  try {
    const parsed = JSON.parse(raw) as { id?: unknown };
    id = typeof parsed.id === "string" ? parsed.id : "";
    if (!id) throw new Error("reboot request needs an id");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out(`✖ rejecting reboot request: ${message}`);
    await writeJsonAtomic(statusFile, {
      phase: "failed",
      source: "reboot",
      error: `reboot request rejected: ${message}`,
      ts: Date.now(),
    });
    rmSync(requestPath, { force: true });
    return 0;
  }

  await writeJsonAtomic(statusFile, {
    phase: "running",
    id,
    source: "reboot",
    logTail: "rebooting the host",
    ts: Date.now(),
  });
  // Gone before reboot, so the path unit cannot fire again at boot.
  rmSync(requestPath, { force: true });
  out(`[${id}] systemctl reboot`);

  const result = spawnFn("systemctl", ["reboot"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? (String(result.stderr ?? "").trim() || `exit ${result.status}`);
    out(`✖ reboot failed: ${detail}`);
    await writeJsonAtomic(statusFile, {
      phase: "failed",
      id,
      source: "reboot",
      error: `reboot failed: ${detail}`,
      ts: Date.now(),
    });
    return 1;
  }
  return 0;
}
