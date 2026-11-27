import {
  createHookRunner,
  projectHooksPath,
  userHooksPath,
  type HookListEntry,
  type HookRunner,
} from "./index.js";

export type HooksSnapshot = {
  entries: HookListEntry[];
  paths: { user: string; project: string };
  workspacePath: string;
};

export function createHooksService(appDataRoot: string): {
  list: (workspacePath: string) => Promise<HooksSnapshot>;
  reload: (workspacePath: string) => Promise<HooksSnapshot>;
} {
  let runner: HookRunner | null = null;
  let boundWorkspace = "";

  async function ensure(workspacePath: string): Promise<HookRunner> {
    if (!runner || boundWorkspace !== workspacePath) {
      runner = createHookRunner({
        userDataRoot: appDataRoot,
        workspacePath,
      });
      boundWorkspace = workspacePath;
    }
    await runner.reload();
    return runner;
  }

  async function snapshot(workspacePath: string): Promise<HooksSnapshot> {
    const r = await ensure(workspacePath);
    return {
      entries: r.listEntries(),
      paths: {
        user: userHooksPath(appDataRoot),
        project: projectHooksPath(workspacePath),
      },
      workspacePath,
    };
  }

  return {
    list: snapshot,
    reload: snapshot,
  };
}
