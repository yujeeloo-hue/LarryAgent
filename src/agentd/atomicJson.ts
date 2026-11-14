/**
 * Atomic JSON write shared by the maintenance surfaces (agentd service, its
 * root workers, and the desktop app's main process).
 *
 * `dirname` comes from node:path on purpose. Hand-rolled `lastIndexOf("/")`
 * variants silently break on Windows: a `join()`ed path uses `\`, the search
 * returns -1, and the caller ends up with a bogus directory ("." or a path
 * missing its last character). Writing the temp file into "." drops it into
 * the process cwd — which under the test runner is the repo root, where it
 * lingers forever because it never gets renamed over anything.
 *
 * The temp file is removed on every exit path, including the rename fallback.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const dir = dirname(target);
  await mkdir(dir, { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = join(dir, `.${randomUUID().slice(0, 8)}.json`);
  await writeFile(tmp, body, "utf8");
  try {
    await rename(tmp, target);
  } catch {
    // Exotic filesystem without rename-over-existing — write in place, drop temp.
    try {
      await writeFile(target, body, "utf8");
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
}
