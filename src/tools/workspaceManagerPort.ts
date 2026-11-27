export type WorkspaceManagerEntry = {
  id: string;
  name: string;
  path: string;
};

export type WorkspaceManagerCreateResult = WorkspaceManagerEntry & {
  existing: boolean;
};

export type WorkspaceManagerRenameResult = WorkspaceManagerEntry & {
  previousName?: string;
};

export type WorkspaceManagerPort = {
  create(input: { name: string; path: string }): Promise<WorkspaceManagerCreateResult>;
  rename(input: {
    id?: string;
    path?: string;
    name: string;
  }): Promise<WorkspaceManagerRenameResult>;
};

let configuredManager: WorkspaceManagerPort | null = null;

export function configureWorkspaceManager(port: WorkspaceManagerPort | null): void {
  configuredManager = port;
}

export function getConfiguredWorkspaceManager(): WorkspaceManagerPort | null {
  return configuredManager;
}

export function resolveWorkspaceManager(context: {
  workspaceManager?: WorkspaceManagerPort;
}): WorkspaceManagerPort | null {
  return context.workspaceManager ?? configuredManager;
}
