import { projectFileKey, type UnrealEditorBinding } from "./editorProtocol.js";
import { findUproject } from "./uproject.js";

const bindings = new Map<string, UnrealEditorBinding>();
const listeners = new Set<() => void>();

export function onUnrealEditorBindingsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyBindingsChanged(): void {
  for (const listener of listeners) listener();
}

export function rememberUnrealEditor(binding: UnrealEditorBinding): void {
  const previous = bindings.get(binding.serverId);
  bindings.set(binding.serverId, binding);
  if (previous?.projectKey !== binding.projectKey) notifyBindingsChanged();
}

export function forgetUnrealEditor(serverId: string): void {
  if (bindings.delete(serverId)) notifyBindingsChanged();
}

export function listUnrealEditors(): readonly UnrealEditorBinding[] {
  return [...bindings.values()];
}

export function isUnrealEditorMcpConnected(workspacePath: string): boolean {
  if (!bindings.size || !workspacePath.trim()) return false;
  const projectFile = findUproject(workspacePath)?.uproject;
  if (!projectFile) return false;
  const key = projectFileKey(projectFile);
  return [...bindings.values()].some((binding) => binding.projectKey === key);
}

export function resetUnrealEditorBindings(): void {
  if (!bindings.size) return;
  bindings.clear();
  notifyBindingsChanged();
}
