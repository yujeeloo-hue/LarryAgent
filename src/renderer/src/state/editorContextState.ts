/**
 * Open editor tabs for the turn-start repository snapshot. Dev Mode
 * registers a provider while mounted; prompt senders read it at send time.
 * Main filters the paths to the session workspace, so senders never need to
 * know which workspace the editor shows.
 */

export type EditorContextSnapshot = {
  activeFile: string | null;
  openFiles: string[];
};

type Provider = () => EditorContextSnapshot | null;

let provider: Provider | null = null;

/** Returns an unregister function (no-op if another provider replaced it). */
export function setEditorContextProvider(next: Provider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

/** StartTurnRequest.editorContext shape, or undefined when nothing is open. */
export function currentEditorContext():
  | { activeFile?: string | null; openFiles?: string[] }
  | undefined {
  let snapshot: EditorContextSnapshot | null = null;
  try {
    snapshot = provider?.() ?? null;
  } catch {
    return undefined;
  }
  if (!snapshot || (!snapshot.activeFile && snapshot.openFiles.length === 0)) {
    return undefined;
  }
  return { activeFile: snapshot.activeFile, openFiles: snapshot.openFiles };
}
