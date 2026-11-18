import { execGit } from "../git/execGit.js";
import { isSvnWorkingCopy } from "../svn/index.js";
import { resolveUeEngineSourceRoot } from "../unreal/engineRoot.js";

export type FooterVcsTargets = {
  svn: boolean;
  gitRoot: string | null;
};

export type FooterVcsProbes = {
  isSvnWorkingCopy: (cwd: string) => Promise<boolean>;
  gitToplevel: (cwd: string) => Promise<string | null>;
  resolveEngine: (cwd: string) => Promise<string | null>;
};

export async function gitToplevel(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
    const top = stdout.trim();
    return top || null;
  } catch {
    return null;
  }
}

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
