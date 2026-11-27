import type { Workspace } from "./types.js";

export type WorkspaceLifecycleEvent = { type: "created" | "deleted"; workspace: Workspace };
type Listener = (event: WorkspaceLifecycleEvent) => void;

const listeners = new Set<Listener>();

export function onWorkspaceLifecycle(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitWorkspaceLifecycle(event: WorkspaceLifecycleEvent): void {
  for (const listener of listeners) {
    try { listener(event); } catch (error) { console.warn("[workspace] lifecycle listener failed", error); }
  }
}
