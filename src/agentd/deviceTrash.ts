/**
 * Device-local Trash mover for headless nodes (agentd): routes the rm →
 * "Trash" rewrite into a timestamped directory under the agentd data dir
 * instead of Electron's shell.trashItem (no Electron on the device). Files
 * stay recoverable — nothing is ever hard-deleted by the rewrite.
 */
import { cp, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

/**
 * Build a mover that parks targets at `<trashRoot>/<timestamp>-<uuid8>-<name>`.
 * rename() first (same filesystem, the common case on the Pi rootfs); EXDEV
 * (e.g. /tmp tmpfs) falls back to copy-then-remove so the content always
 * lands in the trash before the source disappears.
 */
export function createDeviceTrashMover(
  trashRoot: string,
): (path: string) => Promise<void> {
  return async (path: string): Promise<void> => {
    await mkdir(trashRoot, { recursive: true });
    const dest = join(
      trashRoot,
      `${Date.now()}-${randomUUID().slice(0, 8)}-${basename(path)}`,
    );
    try {
      await rename(path, dest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await cp(path, dest, { recursive: true });
      await rm(path, { recursive: true, force: true });
    }
  };
}
