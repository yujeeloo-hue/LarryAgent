import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCocoPolicy } from "../coco/policy.js";
import { inCocoScope } from "../coco/scope.js";
import type { CocoAttempt, CocoWork, CocoWorkResult } from "../coco/types.js";
import type { Message } from "../session/types.js";
import type { RegisteredTool } from "../tools/types.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";

const MAX_REPORT_BYTES = 256 * 1024;
const MAX_REPORTS = 12;
const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const textBody = (message: Message): string => message.parts.flatMap(part => part.type === "text" && !part.error ? [part.text] : []).join("\n").trim();

/** Never borrow a later user turn from a session shared by multiple tasks. */
export function executionReply(messages: readonly Message[], startedAt: number, endedAt: number): Message | undefined {
  const window = messages.filter(message => message.createdAt >= startedAt && message.createdAt <= endedAt);
  let lastUser = -1;
  for (let index = window.length - 1; index >= 0; index--) if (window[index]?.role === "user") { lastUser = index; break; }
  const reply = window.slice(lastUser + 1).reverse().find(message => message.role === "assistant");
  return reply && textBody(reply) && !reply.parts.some(part => part.type === "tool_call") ? reply : undefined;
}

/** Only explicit document references; no directory scan or inferred report filename. */
export function reportPaths(markdown: string, deliverables: readonly string[]): string[] {
  const paths = [...deliverables];
  for (const match of markdown.matchAll(/\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)|`([^`\n]+)`/g)) paths.push(match[1] ?? match[2] ?? "");
  return [...new Set(paths.map(path => {
    try { return decodeURIComponent(path.replace(/#.*$/, "")); } catch { return path; }
  }).filter(path => /\.(md|markdown|txt)$/i.test(path) && !/^(?:https?:|data:)/i.test(path)))].slice(0, MAX_REPORTS);
}

export function createCocoWorkResults(deps: CocoServiceDeps) {
  const { repository, store } = deps;
  const assertWork = (workId: string): CocoWork => {
    if (typeof workId !== "string" || !workId) throw new Error("A task is required to read its results.");
    const work = repository.get<CocoWork>("work", workId);
    if (!deps.alive() || !work || !inCocoScope(deps.engine().settings(), work.workspaceId)
      || !store.listWorkspaces().some(workspace => workspace.id === work.workspaceId)) throw new Error("This task is excluded or unavailable.");
    return work;
  };
  const list = (workId: string): CocoWorkResult[] => repository.forWork<CocoWorkResult>("workResult", workId).sort((a,b) => b.at - a.at || b.capturedAt - a.capturedAt);
  const save = (work: CocoWork, input: Omit<CocoWorkResult, "id" | "workId" | "revision" | "capturedAt">): CocoWorkResult => {
    if (assertWork(work.id).revision !== work.revision) throw new Error("Task requirements changed before the result was saved.");
    const id = hash(JSON.stringify([work.id, work.revision, input.attemptId ?? "legacy", input.source, input.path ?? input.messageId ?? input.title, input.markdown]));
    const saved = repository.get<CocoWorkResult>("workResult", id);
    if (saved) return saved;
    return repository.put("workResult", { ...input, id, workId: work.id, revision: work.revision, capturedAt: Date.now() });
  };
  const readReport = async (work: CocoWork, path: string, changedBefore?: number): Promise<{ path: string; markdown: string }> => {
    const workspace = store.listWorkspaces().find(project => project.id === work.workspaceId);
    if (!workspace) throw new Error("The report's project is unavailable.");
    const full = resolve(workspace.path, path.startsWith("file:") ? fileURLToPath(path) : path);
    if (![".md", ".markdown", ".txt"].includes(extname(full).toLowerCase())) throw new Error("Publish a Markdown or plain text report, or supply its Markdown content.");
    const policy = createCocoPolicy(workspace.path, store.listWorkspaces().filter(project => project.id !== work.workspaceId).map(project => ({ path: project.path, code: deps.engine().settings().excludedWorkspaceIds.includes(project.id) ? "excluded_project" as const : "other_project" as const })), false, () => {
      try { assertWork(work.id); return true; } catch { return false; }
    });
    policy.assertPath(full);
    const file = await open(full, "r");
    try {
      policy.assertPath(full);
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_REPORT_BYTES) throw new Error("Report previews support text files up to 256 KiB.");
      if (changedBefore !== undefined && info.mtimeMs > changedBefore) throw new Error("This file changed after the run; its current contents are not the historical report.");
      const bytes = Buffer.alloc(MAX_REPORT_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const chunk = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (!chunk.bytesRead) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MAX_REPORT_BYTES || bytes.subarray(0, bytesRead).includes(0)) throw new Error("The report is too large or is not a text file.");
      const afterRead = await file.stat();
      if (afterRead.mtimeMs !== info.mtimeMs || afterRead.size !== info.size) throw new Error("The report changed while it was being saved. Publish it again when writing is complete.");
      policy.assertPath(full);
      const body = bytes.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "");
      if (!body.trim()) throw new Error("The report is empty.");
      return { path: full, markdown: extname(full).toLowerCase() === ".txt" ? body.replace(/^/gm, "> ") : body };
    } finally { await file.close(); }
  };
  const capture = async (workId: string, imported = false): Promise<CocoWorkResult[]> => {
    const work = assertWork(workId);
    // Read the original attempt's time window, rather than whichever reply the shared session now ends in.
    const attempts = repository.forWork<CocoAttempt>("attempt", work.id).filter(attempt => (attempt.resultRevision ?? attempt.revision) === work.revision && attempt.status === "finished");
    const windows = attempts.length ? attempts : [{ id: undefined, sessionId: work.sessionId ?? work.observeSessionId, startedAt: work.createdAt, endedAt: work.updatedAt }];
    for (const attempt of windows.slice(-MAX_REPORTS)) {
      const sessionId = attempt.sessionId ?? work.observeSessionId;
      if (!sessionId || !attempt.endedAt) continue;
      if (list(work.id).some(result => result.revision === work.revision && result.attemptId === attempt.id)) continue;
      const session = store.getSession(sessionId);
      if (!session || session.workspaceId !== work.workspaceId) continue;
      const observingOriginalTurn = sessionId === work.observeSessionId && (!attempt.sessionId || !attempt.id && !work.sessionId);
      const reply = executionReply(session.messages, observingOriginalTurn ? session.createdAt : attempt.startedAt, attempt.endedAt);
      if (!reply) continue;
      const body = textBody(reply);
      const source = { at: reply.createdAt, sessionId, ...(attempt.id ? { attemptId: attempt.id } : {}), ...(imported ? { imported: true } : {}) };
      if (Buffer.byteLength(body) <= MAX_REPORT_BYTES) save(work, { ...source, source: "message", title: "Execution result", markdown: body, messageId: reply.id });
      for (const path of reportPaths(body, work.deliverables)) {
        try {
          const report = await readReport(work, path, attempt.endedAt);
          const heading = report.markdown.trimStart().match(/^#{1,2}\s+(.+?)(?:\s+#+)?\s*$/m)?.[1];
          save(work, { ...source, ...report, source: "file", title: heading?.slice(0, 240) || basename(report.path) });
        } catch { /* Keep the original reply when a referenced file is missing, changed, or outside this task's project. */ }
      }
    }
    assertWork(workId);
    return list(workId);
  };
  const tool = (workId: string, sessionId: () => string | undefined, valid: () => boolean): RegisteredTool => ({
    definition: {
      name: "publish_coco_report",
      description: "Save a finished task report for direct reading in CoCo's run results. Supply title and either the complete markdown or the exact path to an existing project Markdown/text file. Use for deliverable reports, never progress notes. The saved content is an immutable snapshot; this does not mark the task verified.",
      defaultPermissionLevel: 0,
      parameters: { type: "object", properties: { title: { type: "string" }, markdown: { type: "string" }, path: { type: "string" } }, required: ["title"] },
    },
    execute: async args => {
      if (!valid()) throw new Error("This execution is no longer active.");
      const work = assertWork(workId);
      const revision = work.revision;
      if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 240) throw new Error("Use a report title of 1–240 characters.");
      const hasBody = typeof args.markdown === "string" && !!args.markdown.trim(), hasPath = typeof args.path === "string" && !!args.path.trim();
      if (hasBody === hasPath) throw new Error("Supply exactly one of markdown or path.");
      const report = hasPath ? await readReport(work, String(args.path)) : { markdown: String(args.markdown) };
      if (Buffer.byteLength(report.markdown) > MAX_REPORT_BYTES) throw new Error("Keep each report within 256 KiB.");
      if (!valid() || assertWork(workId).revision !== revision) throw new Error("Task requirements changed before the report was saved.");
      const attempt = repository.forWork<CocoAttempt>("attempt", workId).reverse().find(attempt => attempt.status === "running");
      const id = sessionId();
      const saved = save(work, { ...report, source: "report", title: args.title.trim(), at: Date.now(), ...(id ? { sessionId: id } : {}), ...(attempt ? { attemptId: attempt.id } : {}) });
      return { returnCode: 0, content: [{ type: "text", text: JSON.stringify({ saved: true, reportId: saved.id, title: saved.title }) }] };
    },
  });
  return { capture, tool, read: async (workId: string): Promise<CocoWorkResult[]> => {
    const work = assertWork(workId);
    // Opening a live task must not import a half-written assistant reply.
    if (["completed", "cancelled", "to_decide", "waiting"].includes(work.status)) return capture(workId, true);
    return list(workId);
  } };
}
