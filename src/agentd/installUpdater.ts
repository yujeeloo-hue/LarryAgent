/**
 * `agentd install-updater` — one-time bootstrap for console-driven updates.
 *
 * Copies the release's systemd units (main service + root updater path/
 * service) into /etc/systemd/system, creates the update queue/status dirs
 * owned by the service user, daemon-reloads and enables the updater path
 * unit. From then on `updateDevice` from the web console works end to end,
 * and `performAgentdUpdate` keeps the units fresh on every future update —
 * this command never has to be repeated.
 *
 * `--with-reboot` is accepted for older runbooks and changes nothing:
 * reboot is a root path unit (the service sandbox blocks sudo), installed
 * together with the updater.
 *
 * Must run as root (sudo). Everything it installs is listed on stdout and
 * removable by deleting those files — no system packages touched.
 */
import { spawnSync } from "node:child_process";
import {
  chownSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import {
  AGENTD_REBOOT_PATH_UNIT,
  AGENTD_SERVICE_USER,
  AGENTD_UPDATER_PATH_UNIT,
  resolveAgentdDataDir,
  resolveAgentdHomeDir,
  resolveAgentdInstallRoot,
  resolveAgentdUpdateQueueDir,
  resolveAgentdUpdateStatusDir,
} from "./config.js";

const SYSTEMD_DIR = "/etc/systemd/system";
const UNIT_NAMES = [
  "jellybot-agentd.service",
  "jellybot-agentd-update.path",
  "jellybot-agentd-update.service",
  "jellybot-agentd-reboot.path",
  "jellybot-agentd-reboot.service",
];

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function fail(message: string): 1 {
  process.stderr.write(`✖ ${message}\n`);
  return 1;
}

/** uid/gid of the service user from /etc/passwd (null when absent). */
function serviceIds(): { uid: number; gid: number } | null {
  try {
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${AGENTD_SERVICE_USER}:`));
    if (!line) return null;
    const parts = line.split(":");
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
    return { uid, gid };
  } catch {
    return null;
  }
}

export async function runAgentdInstallUpdater(args: string[]): Promise<number> {
  const withReboot = args.includes("--with-reboot");

  if (process.getuid?.() !== 0) {
    return fail("install-updater must run as root:  sudo agentd install-updater [--with-reboot]");
  }
  const installRoot = resolveAgentdInstallRoot();
  if (!installRoot) {
    return fail("cannot locate the release tree (expected <install>/systemd next to this binary)");
  }
  const shipped = join(installRoot, "systemd");
  if (!existsSync(shipped)) {
    return fail(`release ships no systemd units (${shipped} missing)`);
  }

  // ── 1. Unit files ──────────────────────────────────────────
  let unitsChanged = false;
  for (const name of UNIT_NAMES) {
    const source = join(shipped, name);
    if (!existsSync(source)) {
      return fail(`release is missing ${source}`);
    }
    const target = join(SYSTEMD_DIR, name);
    const targetExisted = existsSync(target);
    const same =
      targetExisted && statSync(target, { throwIfNoEntry: false })?.isFile() &&
      readFileSync(target, "utf8") === readFileSync(source, "utf8");
    if (same) {
      log(`• ${name} already current`);
      continue;
    }
    copyFileSync(source, target);
    chmodSync(target, 0o644);
    unitsChanged = true;
    log(`✔ ${targetExisted ? "updated" : "installed"} ${target}`);
  }

  // ── 2. Queue + status dirs (service-user writable) ─────────
  const dataDir = resolveAgentdDataDir();
  const ids = serviceIds();
  if (!ids) {
    log(`⚠ service user ${AGENTD_SERVICE_USER} not found — skipping chown (queue writes may fail)`);
  }
  for (const dir of [resolveAgentdUpdateQueueDir(dataDir), resolveAgentdUpdateStatusDir(dataDir)]) {
    mkdirSync(dir, { recursive: true });
    if (ids) {
      try {
        chownSync(dir, ids.uid, ids.gid);
      } catch (error) {
        log(`⚠ chown ${dir} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    chmodSync(dir, 0o755);
    log(`✔ ${dir} ready`);
  }
  const homeDir = resolveAgentdHomeDir();
  mkdirSync(homeDir, { recursive: true });
  log(`• workspace home present: ${homeDir}`);

  // ── 3. Reload + enable ─────────────────────────────────────
  const reload = spawnSync("systemctl", ["daemon-reload"]);
  if (reload.error || reload.status !== 0) {
    log("⚠ systemctl daemon-reload failed — run it manually");
  } else {
    log("✔ systemctl daemon-reload");
  }
  void unitsChanged;
  for (const unit of [AGENTD_UPDATER_PATH_UNIT, AGENTD_REBOOT_PATH_UNIT]) {
    const enable = spawnSync("systemctl", ["enable", "--now", unit]);
    if (enable.error || enable.status !== 0) {
      log(`✖ could not enable ${unit} — run: systemctl enable --now ${unit}`);
    } else {
      log(`✔ ${unit} enabled`);
    }
  }
  log(`✔ update watcher: ${resolveAgentdUpdateQueueDir(dataDir)}/request.json`);
  log(`✔ reboot watcher: ${resolveAgentdUpdateQueueDir(dataDir)}/reboot.json`);
  if (withReboot) {
    log("• --with-reboot is obsolete: reboot is included (root queue, not sudoers)");
  }

  log("");
  log("Done. The web console can now restart, update, and reboot this device (Devices → Maintenance).");
  log("Verify:  systemctl status jellybot-agentd-update.path jellybot-agentd-reboot.path");
  return 0;
}
