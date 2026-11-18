import { cp, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";

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
