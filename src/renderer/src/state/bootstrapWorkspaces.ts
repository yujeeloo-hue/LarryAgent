import { bootstrapWorkspacesState } from "./workspaceState.js";

export async function bootstrapWorkspacesFromMain(): Promise<void> {
  await bootstrapWorkspacesState();
}
