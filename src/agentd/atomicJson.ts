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
    try {
      await writeFile(target, body, "utf8");
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  }
}
