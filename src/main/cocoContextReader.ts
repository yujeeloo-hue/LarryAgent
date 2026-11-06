import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CocoContext } from "../coco/engine.js";
import { CocoPathError, createCocoPolicy } from "../coco/policy.js";
import type { CocoRepository } from "../coco/repository.js";
import type { CocoWork } from "../coco/types.js";
import { clipText } from "../coco/transcriptDigest.js";
import type { MessagePart } from "../session/types.js";
import type { SessionStore } from "./sessionRuntime.js";

export type CocoContextReadArgs = { workspaceId?: unknown; sessionId?: unknown; workId?: unknown; path?: unknown; query?: unknown; pattern?: unknown };

const FILE_LIMIT_BYTES = 65536;
const DIR_ENTRY_LIMIT = 300;
const QUERY_RESULT_LIMIT = 25;
const TRANSCRIPT_TURNS = 3;
const SEARCH_FILE_LIMIT = 300;
const SEARCH_MATCH_LIMIT = 30;
const SEARCH_FILE_BYTES = 256 * 1024;
const SKIP_SEARCH_DIRS = new Set(["node_modules", ".git", "dist", "out", "release", "tmp", ".jellybot"]);

/**
 * A single unbounded read once put a 5 MB transcript into Chat and every later
 * request over the provider limit, so every field is clipped and the newest
 * messages are kept within a fixed character budget.
 */
export const TRANSCRIPT_TEXT_CHARS = 4000;
export const TRANSCRIPT_TOOL_ARGS_CHARS = 500;
export const TRANSCRIPT_TOOL_RESULT_CHARS = 2000;
export const TRANSCRIPT_BUDGET_CHARS = 60_000;

function reviewPart(part: MessagePart): unknown {
  switch (part.type) {
    case "text": return { type: "text", text: clipText(part.text, TRANSCRIPT_TEXT_CHARS), ...(part.error ? { error: true } : {}) };
    case "tool_call": return { type: "tool_call", name: part.name, status: part.status, arguments: clipText(part.argumentsRaw, TRANSCRIPT_TOOL_ARGS_CHARS) };
    case "tool_result": return {
      type: "tool_result", returnCode: part.returnCode,
      text: clipText(part.content.map(c => c.type === "text" ? c.text : `[attachment ${c.name ?? c.uri}]`).join("\n"), TRANSCRIPT_TOOL_RESULT_CHARS),
    };
    case "attachment": return { type: "attachment", kind: part.kind, name: part.name, uri: part.uri };
    case "hosted_tool": return { type: "hosted_tool", name: part.name, status: part.status };
    case "context_compaction": return { type: "context_compaction", summary: clipText(part.summary, TRANSCRIPT_TEXT_CHARS) };
    default: return undefined;
  }
}

/** Bounded session transcript for review (reasoning and replay envelopes dropped). */
export function reviewTranscript(store: SessionStore, sessionId: string, turns: number) {
  const tail = store.getSessionTail(sessionId, { turns });
  if (!tail) return null;
  const { session } = tail;
  const projected = session.messages.map(message => ({
    id: message.id, role: message.role, createdAt: message.createdAt,
    parts: message.parts.map(reviewPart).filter(part => part !== undefined),
  })).filter(message => message.parts.length > 0);
  const messages: typeof projected = [];
  let used = 0;
  for (let index = projected.length - 1; index >= 0; index--) {
    const size = JSON.stringify(projected[index]).length;
    if (messages.length > 0 && used + size > TRANSCRIPT_BUDGET_CHARS) break;
    messages.unshift(projected[index]!);
    used += size;
  }
  const omitted = projected.length - messages.length;
  return {
    session: {
      id: session.id, title: session.title, status: session.status, progressText: session.progressText,
      workspaceId: session.workspaceId, source: session.source, createdAt: session.createdAt, updatedAt: session.updatedAt,
      ...(session.plan ? { plan: { title: session.plan.title, status: session.plan.status, steps: session.plan.steps.map(step => ({ title: clipText(step.title, 200), status: step.status })) } } : {}),
      messages,
    },
    window: { ...tail.window, ...(omitted ? { omittedMessages: omitted } : {}) },
  };
}

/**
 * The one scoped reader behind every CoCo context tool (Chat `coco_context`,
 * background `read_coco_context`). Scope errors throw; every read is audited.
 */
export function createCocoContextReader(deps: { store: SessionStore; repository: CocoRepository; allowed(): CocoContext; valid(): boolean }) {
  const { store, repository } = deps;
  const read = async (args: CocoContextReadArgs): Promise<unknown> => {
    const allowed = deps.allowed();
    const project = allowed.workspaces.find(w => w.id === args.workspaceId);
    if (!project?.path) throw new Error("This project is excluded or unavailable");
    if (args.sessionId !== undefined) {
      if (!allowed.sessions.some(s => s.id === args.sessionId && s.workspaceId === project.id)) throw new Error("This session is excluded or belongs to a different project");
      return reviewTranscript(store, String(args.sessionId), TRANSCRIPT_TURNS);
    }
    if (args.workId !== undefined) {
      const work = repository.get<CocoWork>("work", String(args.workId));
      if (!work || work.workspaceId !== project.id) throw new Error("Work context is unavailable");
      return { ...work, timeline: work.timeline.slice(-20) };
    }
    if (args.query !== undefined) {
      if (typeof args.query !== "string" || args.query.length > 200) throw new Error("Use a session title query of at most 200 characters");
      const query = args.query.toLowerCase();
      return { sessions: allowed.sessions.filter(s => s.workspaceId === project.id && s.title.toLowerCase().includes(query)).slice(0, QUERY_RESULT_LIMIT) };
    }
    const excluded = store.listWorkspaces().filter(w => !allowed.workspaces.some(p => p.id === w.id)).map(w => w.path);
    const policy = createCocoPolicy(project.path, excluded, false, deps.valid, { fullAccess: true });
    const full = resolve(project.path, typeof args.path === "string" ? args.path : ".");
    policy.assertPath(full);
    const info = await stat(full);
    policy.assertPath(full);
    if (typeof args.pattern === "string") {
      const needle = args.pattern.trim();
      if (!needle || needle.length > 200) throw new Error("Use a search pattern of at most 200 characters");
      const matches: { path: string; line: number; text: string }[] = [];
      const budget = { files: 0 };
      const visit = async (target: string, fileInfo: { isDirectory(): boolean; isFile(): boolean; size: number }): Promise<void> => {
        if (matches.length >= SEARCH_MATCH_LIMIT || budget.files >= SEARCH_FILE_LIMIT) return;
        if (fileInfo.isDirectory()) {
          for (const name of await readdir(target)) {
            if (matches.length >= SEARCH_MATCH_LIMIT || budget.files >= SEARCH_FILE_LIMIT || SKIP_SEARCH_DIRS.has(name)) continue;
            const child = resolve(target, name);
            try { policy.assertPath(child); }
            catch (error) { if (error instanceof CocoPathError) continue; throw error; }
            await visit(child, await stat(child));
          }
          return;
        }
        if (!fileInfo.isFile() || fileInfo.size > SEARCH_FILE_BYTES) return;
        budget.files++;
        let content = "";
        try { content = await readFile(target, "utf8"); }
        catch { return; }
        const lowered = needle.toLowerCase();
        const lines = content.split("\n");
        for (let index = 0; index < lines.length && matches.length < SEARCH_MATCH_LIMIT; index++) {
          const text = lines[index];
          if (text?.toLowerCase().includes(lowered)) matches.push({ path: target, line: index + 1, text: text.slice(0, 500) });
        }
      };
      await visit(full, info);
      return { pattern: needle, matches };
    }
    if (info.isDirectory()) {
      const visible = (name: string): boolean => {
        try { policy.assertPath(resolve(full, name)); return true; }
        catch (error) { if (error instanceof CocoPathError) return false; throw error; }
      };
      return { path: full, entries: (await readdir(full)).filter(visible).slice(0, DIR_ENTRY_LIMIT) };
    }
    if (info.isFile() && info.size <= FILE_LIMIT_BYTES) return { path: full, content: await readFile(full, "utf8") };
    throw new Error("Read a specific text file smaller than 64 KiB");
  };
  return async (args: CocoContextReadArgs): Promise<unknown> => {
    const audit = { id: randomUUID(), at: Date.now(), workspaceId: args.workspaceId ?? null, sessionId: args.sessionId ?? null, path: args.path ?? null };
    try {
      const value = await read(args);
      repository.put("contextRead", { ...audit, status: "read" });
      return value;
    } catch (error) {
      repository.put("contextRead", { ...audit, status: "error", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
}
