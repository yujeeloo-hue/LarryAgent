import { execSvn } from "../svn/execSvn.js";
import { gitHeadFact } from "./gitFacts.js";
import type { CocoVcsFact } from "./types.js";

export async function svnRevisionFact(root: string): Promise<string | null> {
  try {
    const { stdout } = await execSvn(root, ["info", "--show-item", "revision"], { maxBuffer: 64 * 1024 });
    const revision = stdout.trim();
    return /^\d+$/.test(revision) ? revision : null;
  } catch { return null; }
}

export async function projectVcsFact(root: string): Promise<CocoVcsFact | null> {
  const git = gitHeadFact(root);
  if (git) return { kind: "git", ref: git.ref, commit: git.commit };
  const revision = await svnRevisionFact(root);
  return revision ? { kind: "svn", revision } : null;
}
