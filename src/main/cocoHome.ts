import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PersonaOverride } from "../agent/turnHost/buildSystemPrefix.js";
import type { StreamChatFn } from "../agent/types.js";
import { dispatchLlmApi } from "../llm/apiDispatch.js";
import { resolveClient } from "./sessionRuntime.js";
import {
  COCO_MEMORY_FALLBACK_RATIO, COCO_MEMORY_FILENAME, COCO_MEMORY_SOFT_CAP,
  acceptConsolidated, applyCocoMemoryUpdate, droppedEntries, removeProjectEntry, trimCocoMemory, upsertProjectEntry,
  type CocoMemoryArchiveEntry, type CocoMemorySection,
} from "../coco/memory.js";
import type { CocoRepository } from "../coco/repository.js";
import { getCocoPrompt } from "../settings/promptDefaults.js";
import type { SessionDatabase } from "../session/db/openDb.js";
import { COCO_HOME_WORKSPACE_ID, getWorkspace, upsertWorkspace } from "../workspace/index.js";

export const COCO_HOME_DIRNAME = "coco";
const PERSONA_FILES = { agent: "AGENT.md", soul: "SOUL.md", autonomous: "COCO_AUTONOMOUS_EXEC_PROMPT.md" } as const;

export function cocoHomePath(appDataRoot: string): string {
  return join(appDataRoot, COCO_HOME_DIRNAME);
}

const seed = (path: string, body: string): void => {
  if (!existsSync(path) && body.trim()) writeFileSync(path, `${body.trim()}\n`, "utf8");
};

/** sha256 of the last default written per home file; a file still matching it was never edited. */
const SEEDED_FILE = ".seeded.json";
/** Shipped defaults from before `.seeded.json` existed (sha256 of the trimmed body + "\n"). */
const LEGACY_DEFAULT_HASHES: Record<string, readonly string[]> = {
  [PERSONA_FILES.agent]: ["c5dd74c6c3c52b744bab69524d7534bde52bd0612db9fb77c7c22b7dc7a4c643", "508983940d546c35f0650c4bc8f4caaac59b2c43857b8f5b33332cf99ea4185e"],
  [PERSONA_FILES.soul]: [],
  [PERSONA_FILES.autonomous]: ["eee7ca6080231a065ad2a238a06b8ea43d4cd8f29a78799610f62f0d8e8b5d2a"],
};
const normalized = (body: string): string => `${body.replace(/^\uFEFF/, "").trim()}\n`;
const sha256 = (body: string): string => createHash("sha256").update(body).digest("hex");

/** Seed missing persona files and move untouched copies to the current default; edited copies are left alone. */
function syncPersonaDefaults(home: string, defaults: Record<string, string>): void {
  const recordPath = join(home, SEEDED_FILE);
  let record: Record<string, string> = {};
  try { record = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, string>; } catch { /* first run */ }
  let changed = false;
  for (const [name, body] of Object.entries(defaults)) {
    if (!body.trim()) continue;
    const path = join(home, name), next = normalized(body), nextHash = sha256(next);
    let current: string | undefined;
    try { current = sha256(normalized(readFileSync(path, "utf8"))); } catch { /* missing */ }
    const untouched = current === undefined || current === record[name] || (!record[name] && LEGACY_DEFAULT_HASHES[name]?.includes(current));
    if (untouched && current !== nextHash) writeFileSync(path, next, "utf8");
    if ((untouched || current === nextHash) && record[name] !== nextHash) { record[name] = nextHash; changed = true; }
  }
  if (changed) writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** Create the home directory, seed persona/memory files and keep the reserved workspace row current. */
export function ensureCocoHome(appDataRoot: string, db: SessionDatabase): string {
  const home = cocoHomePath(appDataRoot);
  mkdirSync(home, { recursive: true });
  syncPersonaDefaults(home, {
    [PERSONA_FILES.agent]: getCocoPrompt("AGENT"),
    [PERSONA_FILES.soul]: getCocoPrompt("SOUL"),
    [PERSONA_FILES.autonomous]: getCocoPrompt("COCO_AUTONOMOUS_EXEC_PROMPT"),
  });
  seed(join(home, COCO_MEMORY_FILENAME), getCocoPrompt("COCO_MEMORY"));
  const existing = getWorkspace(db, COCO_HOME_WORKSPACE_ID);
  if (!existing || existing.path !== home) {
    const now = Date.now();
    upsertWorkspace(db, { id: COCO_HOME_WORKSPACE_ID, name: "CoCo", path: home, origin: "user", createdAt: existing?.createdAt ?? now, updatedAt: now });
  }
  return home;
}

const readOr = (path: string, fallback: () => string): string => {
  try {
    const body = readFileSync(path, "utf8").replace(/^\uFEFF/, "").trim();
    if (body) return body;
  } catch { /* missing → default */ }
  return fallback();
};

/** Re-read on every model iteration so edits to the home files apply immediately. */
export function readCocoPersona(home: string): PersonaOverride {
  return {
    agent: readOr(join(home, PERSONA_FILES.agent), () => getCocoPrompt("AGENT")),
    soul: readOr(join(home, PERSONA_FILES.soul), () => getCocoPrompt("SOUL")),
    memory: { label: "COCO_MEMORY", body: readOr(join(home, COCO_MEMORY_FILENAME), () => getCocoPrompt("COCO_MEMORY")) },
  };
}

/** Autonomous wake: the home's self-editable instructions become the `[AUTONOMOUS]` block, without workspace or hand-off lines. */
export function readCocoAutonomousPersona(home: string): PersonaOverride {
  return {
    ...readCocoPersona(home),
    scenario: { label: "AUTONOMOUS", body: readOr(join(home, PERSONA_FILES.autonomous), () => getCocoPrompt("COCO_AUTONOMOUS_EXEC_PROMPT")) },
    lean: true,
  };
}

export function resetCocoAutonomousPrompt(home: string): void {
  mkdirSync(home, { recursive: true });
  rmSync(join(home, PERSONA_FILES.autonomous), { force: true });
  syncPersonaDefaults(home, { [PERSONA_FILES.autonomous]: getCocoPrompt("COCO_AUTONOMOUS_EXEC_PROMPT") });
}

export type CocoMemoryArchiveRecord = CocoMemoryArchiveEntry & { id: string; at: number; reason: "consolidate" | "trim" | "replace" };
/** LLM consolidation: returns the rewritten body, or throws. */
export type CocoMemoryConsolidateFn = (body: string, budget: number) => Promise<string>;

/** Serialized COCO_MEMORY.md writes; every entry that leaves the file is archived first. */
export function createCocoMemory(input: { home: string; repository: CocoRepository; timezone(): string; now?(): number }) {
  const path = join(input.home, COCO_MEMORY_FILENAME);
  const now = input.now ?? Date.now;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = chain.then(fn, fn); chain = next.catch(() => undefined); return next; };

  const read = async (): Promise<string> => {
    try { return (await readFile(path, "utf8")).replace(/^\uFEFF/, ""); }
    catch { return `${getCocoPrompt("COCO_MEMORY").trim()}\n`; }
  };
  const write = async (body: string): Promise<void> => {
    await mkdir(input.home, { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, body, "utf8");
    await rename(temp, path);
  };
  const archive = (entries: CocoMemoryArchiveEntry[], reason: CocoMemoryArchiveRecord["reason"]): void => {
    const at = now();
    input.repository.transaction(() => { for (const entry of entries) input.repository.put<CocoMemoryArchiveRecord>("memoryArchive", { id: randomUUID(), at, reason, ...entry }); });
  };
  const stamp = (): string => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: input.timezone(), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now()).map(p => [p.type, p.value]));
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
  };

  /** Over the cap: try the LLM, accept only a well-formed result, else trim oldest-first. Archive before writing. */
  const fit = async (body: string, consolidate?: CocoMemoryConsolidateFn): Promise<{ body: string; archived: number; method?: "consolidate" | "trim" }> => {
    if (body.length <= COCO_MEMORY_SOFT_CAP) return { body, archived: 0 };
    if (consolidate) {
      try {
        const candidate = (await consolidate(body, Math.floor(COCO_MEMORY_SOFT_CAP * COCO_MEMORY_FALLBACK_RATIO))).trim();
        if (acceptConsolidated(body, candidate, COCO_MEMORY_SOFT_CAP)) {
          const dropped = droppedEntries(body, candidate);
          archive(dropped, "consolidate");
          return { body: `${candidate}\n`, archived: dropped.length, method: "consolidate" };
        }
      } catch (error) { console.warn("[coco] memory consolidation failed; trimming oldest entries", error); }
    }
    const trimmed = trimCocoMemory(body, Math.floor(COCO_MEMORY_SOFT_CAP * COCO_MEMORY_FALLBACK_RATIO));
    archive(trimmed.removed, "trim");
    return { body: trimmed.body, archived: trimmed.removed.length, method: "trim" };
  };

  /** Apply a pure edit; superseded entries are archived, then the result is fitted under the cap. */
  const mutate = (edit: (body: string) => { body: string; removed: CocoMemoryArchiveEntry[] }, consolidate?: CocoMemoryConsolidateFn) => serial(async () => {
    const applied = edit(await read());
    if (applied.removed.length) archive(applied.removed, "replace");
    const fitted = await fit(applied.body, consolidate);
    await write(fitted.body);
    return { chars: fitted.body.length, cap: COCO_MEMORY_SOFT_CAP, archived: applied.removed.length + fitted.archived, ...(fitted.method ? { compacted: fitted.method } : {}) };
  });

  return {
    path,
    read,
    update: (args: { section: CocoMemorySection; content: string; mode: "merge" | "replace" }, consolidate?: CocoMemoryConsolidateFn) =>
      mutate(body => applyCocoMemoryUpdate(body, { ...args, stamp: stamp() }), consolidate),
    upsertProject: (project: { name: string; path: string; line: string }, consolidate?: CocoMemoryConsolidateFn) =>
      mutate(body => upsertProjectEntry(body, project), consolidate),
    removeProject: (projectPath: string) => mutate(body => removeProjectEntry(body, projectPath)),
    searchArchive: (query: string, limit: number) => {
      const terms = query.split(/\s+/).map(t => t.trim()).filter(Boolean).slice(0, 8);
      return input.repository.searchMemoryArchive<CocoMemoryArchiveRecord>(terms, Math.max(1, Math.min(50, limit)));
    },
  };
}
export type CocoMemory = ReturnType<typeof createCocoMemory>;

const COCO_MEMORY_CONSOLIDATE_TIMEOUT_MS = 120_000;

/** One reasoning-free, metered rewrite of an over-cap memory body. */
export function memoryConsolidator(input: { root: string; home: string; providerId: string; signal: AbortSignal; stream: StreamChatFn }): CocoMemoryConsolidateFn {
  return async (body, budget) => {
    const client = await resolveClient(input.root, input.home, input.providerId || undefined, { fallbackIfMissing: true });
    const { reasoningEffort: _effort, ...base } = client;
    const extraBody = dispatchLlmApi(client).requestExtraBody({ ...base, disableReasoning: true });
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(COCO_MEMORY_CONSOLIDATE_TIMEOUT_MS)]);
    let text = "";
    for await (const event of input.stream({ ...base, disableReasoning: true }, {
      messages: [{ role: "system", content: getCocoPrompt("memory-consolidate") }, { role: "user", content: JSON.stringify({ budgetCharacters: budget, memory: body }) }],
      signal,
      ...(extraBody ? { extraBody } : {}),
    })) {
      if (event.type === "text_delta") text += event.text;
      if (event.type === "error") throw new Error(event.message);
    }
    return text.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/u, "$1");
  };
}
