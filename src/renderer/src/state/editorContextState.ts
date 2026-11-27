
export type EditorContextSnapshot = {
  activeFile: string | null;
  openFiles: string[];
};

type Provider = () => EditorContextSnapshot | null;

let provider: Provider | null = null;

export function setEditorContextProvider(next: Provider): () => void {
  provider = next;
  return () => {
    if (provider === next) provider = null;
  };
}

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
