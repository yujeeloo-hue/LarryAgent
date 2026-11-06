import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";

/** Read only the selected worktree's HEAD. Handles .git files and shared refs. */
export function gitHeadFact(root: string): { commit: string; ref: string } | null {
  try {
    let git = join(root, ".git");
    try {
      const pointer = readFileSync(git, "utf8").trim();
      if (!pointer.startsWith("gitdir:")) return null;
      git = resolve(root, pointer.slice(7).trim());
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error; }
    let common = git;
    try { common = resolve(git, readFileSync(join(git,"commondir"),"utf8").trim()); } catch { /* Ordinary repository. */ }
    const head = readFileSync(join(git,"HEAD"),"utf8").trim();
    const ref = head.startsWith("ref: ") ? head.slice(5) : "detached";
    let commit = head;
    if (ref !== "detached") {
      if (!/^refs\/[a-zA-Z0-9_./-]+$/.test(ref) || ref.split("/").includes("..")) return null;
      try { commit = readFileSync(join(common,ref),"utf8").trim(); }
      catch { commit = readFileSync(join(common,"packed-refs"),"utf8").split("\n").find(line=>line.endsWith(` ${ref}`))?.split(" ")[0] ?? ""; }
    }
    return /^[a-f0-9]{40,64}$/i.test(commit) ? { commit, ref } : null;
  } catch { return null; }
}
