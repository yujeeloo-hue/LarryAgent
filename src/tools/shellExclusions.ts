import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export function excludedProjectShell(command: string, args: string[], roots: string[], platform = process.platform): { command: string; args: string[] } {
  if (!roots.length) return { command, args };
  if (platform !== "darwin") throw new Error("Shell cannot enforce excluded project access on this platform");
  const paths = new Set<string>();
  for (const root of roots) { paths.add(resolve(root)); try { paths.add(realpathSync.native(root)); } catch {  } }
  const filters = [...paths].map(path => `(subpath ${JSON.stringify(path)})`).join(" ");
  return { command: "/usr/bin/sandbox-exec", args: ["-p", `(version 1)\n(allow default)\n(deny file-read* file-write* ${filters})`, command, ...args] };
}
