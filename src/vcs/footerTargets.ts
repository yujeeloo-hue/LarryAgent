/**
 * Which sync actions the conversation footer may offer.
 *
 * Update (`svn update`) belongs to an SVN working copy at the workspace root.
 * Pull (`git pull`) belongs to a Git toplevel: the workspace itself when it
 * is a Git repo, otherwise the associated Unreal engine source tree when
 * that tree is Git (game project in SVN, engine checkout in Git).
 */
import { execGit } from "../git/execGit.js";
import { isSvnWorkingCopy } from "../svn/index.js";
import { resolveUeEngineSourceRoot } from "../unreal/engineRoot.js";

export type FooterVcsTargets = {
  /** Workspace root is an SVN working copy. */
  svn: boolean;
  /**
   * Git toplevel `git pull` should run in. Null when neither the workspace
   * nor its engine source is a Git repo.
   */
  gitRoot: string | null;
};

export type FooterVcsProbes = {
  isSvnWorkingCopy: (cwd: string) => Promise<boolean>;
  gitToplevel: (cwd: string) => Promise<string | null>;
  resolveEngine: (cwd: string) => Promise<string | null>;
};

/** Git toplevel containing `cwd`, or null when `cwd` is not inside a work tree. */
export async function gitToplevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
    const top = stdout.trim();
    return top || null;
  } catch {
    return null;
  }
}

/**
 * Workspace Git wins over the engine. The engine is consulted only when the
 * workspace itself is not a Git repo, so an ordinary Git project does not
 * grow a second Pull target.
 */
export function selectFooterGitRoot(input: {
  workspaceGitRoot: string | null;
  engineGitRoot: string | null;
}): string | null {
  return input.workspaceGitRoot ?? input.engineGitRoot;
}

export async function resolveFooterVcsTargets(
  workspacePath: string,
  probes?: Partial<FooterVcsProbes>,
): Promise<FooterVcsTargets> {
  const isSvn = probes?.isSvnWorkingCopy ?? isSvnWorkingCopy;
  const toplevel = probes?.gitToplevel ?? gitToplevel;
  const resolveEngine = probes?.resolveEngine ?? resolveUeEngineSourceRoot;

  const [svn, workspaceGitRoot] = await Promise.all([
    isSvn(workspacePath),
    toplevel(workspacePath),
  ]);
  if (workspaceGitRoot) {
    return { svn, gitRoot: workspaceGitRoot };
  }
  if (!svn) return { svn: false, gitRoot: null };

  const engine = await resolveEngine(workspacePath);
  const engineGitRoot = engine ? await toplevel(engine) : null;
  return { svn: true, gitRoot: selectFooterGitRoot({ workspaceGitRoot: null, engineGitRoot }) };
}
