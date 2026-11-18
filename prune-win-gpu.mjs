import { rm, stat } from "node:fs/promises";
import { join } from "node:path";

const PRUNE = ["dxcompiler.dll", "dxil.dll"];

export default async function pruneWinGpu(context) {
  if (context.electronPlatformName !== "win32") return;

  let freed = 0;
  for (const name of PRUNE) {
    const target = join(context.appOutDir, name);
    const { size } = await stat(target).catch(() => {
      throw new Error(
        `[prune-win-gpu] expected ${name} in ${context.appOutDir} but it is missing — ` +
          `Electron's payload changed; re-check whether this prune is still correct.`,
      );
    });
    await rm(target);
    freed += size;
  }

  console.log(
    `  • pruned unused GPU binaries  files=${PRUNE.length} freed=${(freed / 1024 / 1024).toFixed(1)}MB`,
  );
}
