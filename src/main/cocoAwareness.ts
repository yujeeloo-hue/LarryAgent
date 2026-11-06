import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { clipText } from "../coco/transcriptDigest.js";
import { dispatchLlmApi } from "../llm/apiDispatch.js";
import { onProjectMemoryWritten, projectMemoryFilePath, setProjectMemoryBody } from "../projectMemory/store.js";
import { getCocoPrompt, getDefaultProjectPrompt } from "../settings/promptDefaults.js";
import { runCocoBackground } from "./cocoBackground.js";
import { createCocoContextReader } from "./cocoContextReader.js";
import { memoryConsolidator, type CocoMemory } from "./cocoHome.js";
import { meteredStream } from "./cocoMetering.js";
import type { CocoServiceDeps, CocoUsageFn } from "./cocoServiceDeps.js";
import type { CocoProjectDocNote } from "../coco/wakeLedger.js";
import { resolveClient } from "./sessionRuntime.js";

/** Pending awareness work for one project (record id = workspace id). */
export type CocoProjectTask = { id: string; reason: "onboard" | "added" | "changed"; readyAt: number; at: number; attempts?: number };
/** What CoCo knows about one project (record id = workspace id). */
export type CocoProjectDigest = {
  id: string; name: string; path: string; hash: string;
  state: "documented" | "generated" | "empty";
  line: string; summary: string;
  /** Last meaningful PROJECT.md change. */
  changes?: string | undefined; changedAt?: number | undefined;
  /** When CoCo wrote this project's first PROJECT.md. */
  generatedAt?: number | undefined;
  updatedAt: number;
};
export type CocoAwarenessOutcome = { notices: string[]; changed: string[] };

/** Coalesce bursts of PROJECT.md writes (post-turn extract writes after every turn). */
export const PROJECT_CHANGE_DEBOUNCE_MS = 60_000;
const RETRY_DELAYS_MS = [60_000, 300_000, 900_000];
const BUSY_RETRY_MS = 300_000;
const DIGEST_TIMEOUT_MS = 60_000;
const ANALYZE_TIMEOUT_MS = 600_000;
/** One awareness job yields the coordination lane after this long; the rest runs in the next job. */
const RUN_SLICE_MS = 120_000;
/** The generated digest is recorded just before its PROJECT.md write lands. */
const GENERATED_WRITE_WINDOW_MS = 60_000;
const IGNORED_TOP_LEVEL = /^(\.|node_modules$|PROJECT\.md$)/;

export const projectMdHash = (body: string): string => createHash("sha256").update(body.trim()).digest("hex");

const isTemplate = (body: string): boolean => !body.trim() || body.trim() === getDefaultProjectPrompt().trim();

const parseJsonObject = (text: string): Record<string, unknown> | undefined => {
  const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { const value: unknown = JSON.parse(raw.slice(start, end + 1)); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
  catch { return undefined; }
};
const str = (value: unknown, max: number): string => typeof value === "string" ? clipText(value.replace(/\s+/g, " ").trim(), max) : "";

/** Deterministic fallback when the digest model is unavailable: Basics' first sentences. */
export function fallbackDigest(body: string): { line: string; summary: string } {
  const basics = /##\s+Basics\s*\n([\s\S]*?)(?=\n##\s|$)/i.exec(body)?.[1] ?? body;
  const text = basics.split("\n").map(l => l.replace(/^[-*#>\s]+/, "").trim()).filter(Boolean).join(" ");
  return { line: clipText(text, 160) || "PROJECT.md present", summary: clipText(text, 600) };
}

/**
 * Project awareness: onboarding of every in-scope project, newly added
 * projects, and PROJECT.md changes. Detection is cheap and synchronous;
 * model work runs inside the engine's `project` job so it shares budgets,
 * cooldown and metering.
 */
export function createCocoAwareness(deps: CocoServiceDeps & { memory: CocoMemory; home: string }) {
  const { store, repository } = deps;
  let startupCheck = true;
  const now = (): number => Date.now();
  const scoped = () => deps.context(deps.engine().settings()).workspaces.flatMap(w => w.path ? [{ id: w.id, name: w.name, path: w.path }] : []);
  const queue = (id: string, reason: CocoProjectTask["reason"], readyAt: number): void => {
    const existing = repository.get<CocoProjectTask>("projectTask", id);
    // A pending onboarding/added task already covers a later change.
    const kept = existing && existing.reason !== "changed" ? existing.reason : reason;
    repository.put<CocoProjectTask>("projectTask", { id, reason: kept, readyAt: Math.max(readyAt, existing?.reason === "changed" ? 0 : existing?.readyAt ?? 0), at: existing?.at ?? now() });
  };

  const written = (workspacePath: string, body: string): void => {
    if (!deps.alive() || !deps.engine().settings().enabled) return;
    const project = scoped().find(w => resolve(w.path) === resolve(workspacePath));
    if (!project) return;
    if (repository.get<CocoProjectDigest>("projectDigest", project.id)?.hash === projectMdHash(body)) return;
    queue(project.id, "changed", now() + PROJECT_CHANGE_DEBOUNCE_MS);
  };
  let unsubscribe: (() => void) | undefined;
  let syncing = false;

  /** Called at start, on workspace create/delete and when CoCo's scope changes. Never on a timer. */
  const sync = async (): Promise<void> => {
    if (syncing || !deps.alive() || !deps.engine().settings().enabled) return;
    syncing = true;
    try { await reconcile(); } finally { syncing = false; }
  };
  const reconcile = async (): Promise<void> => {
    const projects = scoped(), onboarded = repository.meta<number>("projectsOnboardedAt", 0);
    for (const project of projects) {
      const digest = repository.get<CocoProjectDigest>("projectDigest", project.id);
      if (!digest) { if (!repository.get("projectTask", project.id)) queue(project.id, onboarded ? "added" : "onboard", now()); continue; }
      if (startupCheck || digest.path !== project.path) {
        // Catches edits made while the app was closed; runtime writes use the listener.
        let body = "";
        try { body = await readFile(projectMemoryFilePath(project.path), "utf8"); } catch { /* missing */ }
        if (projectMdHash(body) !== digest.hash) queue(project.id, "changed", now());
      }
    }
    startupCheck = false;
    if (!onboarded && projects.length) repository.setMeta("projectsOnboardedAt", now());
    for (const digest of repository.list<CocoProjectDigest>("projectDigest")) {
      if (projects.some(p => p.id === digest.id)) continue;
      repository.remove("projectDigest", digest.id);
      repository.remove("projectTask", digest.id);
      await deps.memory.removeProject(digest.path).catch(error => console.warn("[coco] could not drop project from memory", error));
    }
  };

  const ready = (at: number): CocoProjectTask[] => repository.list<CocoProjectTask>("projectTask").filter(t => t.readyAt <= at).sort((a, b) => a.at - b.at);

  const digestCall = async (input: unknown, signal: AbortSignal, usage: CocoUsageFn, providerId: string): Promise<Record<string, unknown> | undefined> => {
    const client = await resolveClient(deps.root, deps.home, providerId || undefined, { fallbackIfMissing: true });
    const { reasoningEffort: _effort, ...base } = client;
    const extraBody = dispatchLlmApi(client).requestExtraBody({ ...base, disableReasoning: true });
    const combined = AbortSignal.any([signal, AbortSignal.timeout(DIGEST_TIMEOUT_MS)]);
    let text = "";
    for await (const event of meteredStream(combined, usage)({ ...base, disableReasoning: true }, {
      messages: [{ role: "system", content: getCocoPrompt("project-digest") }, { role: "user", content: JSON.stringify(input) }],
      signal: combined, ...(extraBody ? { extraBody } : {}),
    })) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "error") throw new Error(event.message);
    }
    return parseJsonObject(text);
  };

  const isEmptyDirectory = async (path: string): Promise<boolean> => (await readdir(path)).every(name => IGNORED_TOP_LEVEL.test(name));
  const hasActiveTurn = (workspaceId: string): boolean => store.listSessions().some(s => s.workspaceId === workspaceId && store.isTurnActive(s.id));

  const handle = async (task: CocoProjectTask, signal: AbortSignal, usage: CocoUsageFn, providers: { main: string; fast: string }): Promise<{ notice?: string; changed?: string }> => {
    const project = scoped().find(p => p.id === task.id);
    if (!project) { repository.remove("projectTask", task.id); return {}; }
    const previous = repository.get<CocoProjectDigest>("projectDigest", project.id);
    const consolidate = memoryConsolidator({ root: deps.root, home: deps.home, providerId: providers.fast, signal, stream: meteredStream(signal, usage) });
    let body = "";
    try { body = (await readFile(projectMemoryFilePath(project.path), "utf8")).replace(/^\uFEFF/, ""); } catch { /* missing */ }
    const base = { id: project.id, name: project.name, path: project.path, updatedAt: now() };

    if (isTemplate(body)) {
      if (task.reason === "changed" && previous) { repository.put<CocoProjectDigest>("projectDigest", { ...previous, ...base, hash: projectMdHash(body) }); return {}; }
      if (await isEmptyDirectory(project.path)) {
        repository.put<CocoProjectDigest>("projectDigest", { ...base, hash: projectMdHash(body), state: "empty", line: "Empty project — no files yet", summary: "" });
        await deps.memory.upsertProject({ name: project.name, path: project.path, line: "Empty project — no files yet" }, consolidate);
        return { notice: `- **${project.name}** — empty so far; I will analyse it once it has files.` };
      }
      // Generating PROJECT.md while another session works there could race its own memory writes.
      if (hasActiveTurn(project.id)) { repository.put<CocoProjectTask>("projectTask", { ...task, readyAt: now() + BUSY_RETRY_MS }); return {}; }
      const valid = (): boolean => deps.alive() && deps.engine().ownsExecution() && !signal.aborted && scoped().some(p => p.id === project.id);
      const entries = (await readdir(project.path)).filter(name => !name.startsWith(".")).slice(0, 80);
      const value = await runCocoBackground({
        root: deps.root, store, repository, purpose: "project", operationId: `project-analyze:${project.id}`, workspaceId: project.id,
        providerId: providers.main, signal, valid, stream: meteredStream(signal, usage), timeoutMs: ANALYZE_TIMEOUT_MS,
        readContext: createCocoContextReader({ store, repository, allowed: () => deps.context(deps.engine().settings()), valid }),
        input: { workspaceId: project.id, name: project.name, path: project.path, topLevelEntries: entries, template: getDefaultProjectPrompt() },
        prompt: getCocoPrompt("project-analyze"),
      }) as Record<string, unknown> | undefined;
      const projectMd = typeof value?.projectMd === "string" ? value.projectMd.trim() : "";
      if (!/^##\s+Basics\s*$/mi.test(projectMd)) throw new Error("Project analysis did not produce a PROJECT.md with a Basics section");
      const line = str(value?.line, 160) || fallbackDigest(projectMd).line;
      // Record the digest first so the write listener recognises this write as ours.
      repository.put<CocoProjectDigest>("projectDigest", { ...base, hash: projectMdHash(projectMd), state: "generated", generatedAt: now(), line, summary: str(value?.summary, 600) || fallbackDigest(projectMd).summary });
      await setProjectMemoryBody(project.path, projectMd);
      await deps.memory.upsertProject({ name: project.name, path: project.path, line }, consolidate);
      await deps.memory.update({ section: "work_log", content: `${project.name}: wrote its first PROJECT.md from a project analysis.`, mode: "merge" }, consolidate);
      return { notice: `- **${project.name}** — ${line} *(PROJECT.md written)*` };
    }

    let digest: { line: string; summary: string; changes: string };
    try {
      const value = await digestCall({ project: { name: project.name, path: project.path }, previousSummary: previous?.summary ?? "", projectMd: clipText(body, 20_000) }, signal, usage, providers.fast);
      const fallback = fallbackDigest(body);
      digest = { line: str(value?.line, 160) || fallback.line, summary: str(value?.summary, 600) || fallback.summary, changes: previous ? str(value?.changes, 300) : "" };
    } catch (error) {
      if (signal.aborted) throw error;
      console.warn("[coco] project digest failed; using a deterministic summary", error);
      digest = { ...fallbackDigest(body), changes: "" };
    }
    const changedAt = digest.changes ? now() : previous?.changedAt;
    repository.put<CocoProjectDigest>("projectDigest", { ...base, hash: projectMdHash(body), state: previous?.state === "generated" ? "generated" : "documented", line: digest.line, summary: digest.summary, changes: digest.changes || previous?.changes, changedAt });
    await deps.memory.upsertProject({ name: project.name, path: project.path, line: digest.line }, consolidate);
    if (digest.changes) await deps.memory.update({ section: "work_log", content: `${project.name}: ${digest.changes}`, mode: "merge" }, consolidate);
    if (task.reason === "changed") return digest.changes ? { changed: project.name } : {};
    return { notice: `- **${project.name}** — ${digest.line}` };
  };

  return {
    sync,
    pending: (at: number): boolean => ready(at).length > 0,
    /** Drain ready tasks; one failing project retries later without blocking the rest. */
    run: async (signal: AbortSignal, usage: CocoUsageFn, providers: { main: string; fast: string }): Promise<CocoAwarenessOutcome> => {
      const onboard: string[] = [], added: string[] = [], changed: string[] = [], until = now() + RUN_SLICE_MS;
      for (const task of ready(now())) {
        signal.throwIfAborted();
        if (now() > until) break;
        try {
          const outcome = await handle(task, signal, usage, providers);
          if (outcome.notice) (task.reason === "onboard" ? onboard : added).push(outcome.notice);
          if (outcome.changed) changed.push(outcome.changed);
          const current = repository.get<CocoProjectTask>("projectTask", task.id);
          // A change that arrived while this one ran stays queued.
          if (current && current.at === task.at && current.readyAt <= task.readyAt) repository.remove("projectTask", task.id);
        } catch (error) {
          if (signal.aborted) throw error;
          const attempts = (task.attempts ?? 0) + 1;
          console.warn(`[coco] project awareness failed for ${task.id} (attempt ${attempts})`, error);
          if (attempts > RETRY_DELAYS_MS.length) repository.remove("projectTask", task.id);
          else repository.put<CocoProjectTask>("projectTask", { ...task, attempts, readyAt: now() + RETRY_DELAYS_MS[attempts - 1]! });
        }
      }
      const notices: string[] = [];
      if (onboard.length) notices.push(`**I've looked through your projects** and noted them in my memory:\n\n${onboard.join("\n")}`);
      if (added.length) notices.push(`**New project${added.length > 1 ? "s" : ""} added** — I've read ${added.length > 1 ? "them" : "it"} and noted ${added.length > 1 ? "them" : "it"} in my memory:\n\n${added.join("\n")}`);
      return { notices, changed };
    },
    /** Wake-briefing note for a ledgered PROJECT.md write: what the digest did, once it has run. */
    docNote: (workspaceId: string, writtenAt: number): CocoProjectDocNote | undefined => {
      const digest = repository.get<CocoProjectDigest>("projectDigest", workspaceId);
      if (!digest) return undefined;
      if (digest.generatedAt && digest.generatedAt <= writtenAt && writtenAt - digest.generatedAt < GENERATED_WRITE_WINDOW_MS) return "first PROJECT.md generated";
      return digest.updatedAt >= writtenAt ? "summary updated in memory" : undefined;
    },
    start: (): void => { unsubscribe ??= onProjectMemoryWritten(written); },
    stop: (): void => { unsubscribe?.(); unsubscribe = undefined; },
  };
}
export type CocoAwareness = ReturnType<typeof createCocoAwareness>;
