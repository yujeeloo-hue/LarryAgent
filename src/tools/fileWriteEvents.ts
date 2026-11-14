import { isAbsolute, resolve } from "node:path";

/** A successful `write_file` / `edit_file` / `append_file` call, with its absolute target path. */
export type ToolFileWrite = { tool: string; path: string; sessionId: string; workspacePath?: string | undefined };
type Listener = (event: ToolFileWrite) => void;

const FILE_WRITE_TOOLS = new Set(["write_file", "edit_file", "append_file"]);
const listeners = new Set<Listener>();

export function onToolFileWrite(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Relative paths resolve against the session workspace; calls without a resolvable path are ignored. */
export function emitToolFileWrite(input: { tool: string; args: Record<string, unknown>; sessionId: string; workspacePath?: string | undefined }): void {
  if (!listeners.size || !FILE_WRITE_TOOLS.has(input.tool)) return;
  const raw = typeof input.args.path === "string" ? input.args.path.trim() : "";
  if (!raw || (!isAbsolute(raw) && !input.workspacePath)) return;
  const path = isAbsolute(raw) ? resolve(raw) : resolve(input.workspacePath!, raw);
  for (const listener of listeners) {
    try { listener({ tool: input.tool, path, sessionId: input.sessionId, workspacePath: input.workspacePath }); }
    catch (error) { console.warn("[tools] file write listener failed", error); }
  }
}
