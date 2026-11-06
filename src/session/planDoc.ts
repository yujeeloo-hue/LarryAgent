import { createHash } from "node:crypto";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import type { SessionPlanDoc } from "./types.js";
import { PLAN_DOC_SUMMARY_MAX } from "./types.js";

export const PLAN_DOC_DIR_SEGMENTS = ["docs", "plans"] as const;
export { PLAN_DOC_SUMMARY_MAX };
/**
 * Advisory plan-doc body length. write_plan_doc never rejects longer
 * content — the recommendation lives in the tool description / prompts and
 * surfaces as a note in successful results past this size.
 */
export const PLAN_DOC_CONTENT_RECOMMENDED = 8_000;

/** Relative dir from workspace root: docs/plans */
export function planDocRelativeDir(): string {
  return PLAN_DOC_DIR_SEGMENTS.join("/");
}

/** Absolute docs/plans directory for a workspace. */
export function planDocDirAbsolute(workspacePath: string): string {
  return join(resolve(workspacePath), ...PLAN_DOC_DIR_SEGMENTS);
}

export function hasPlanDoc(
  doc: SessionPlanDoc | null | undefined,
): doc is SessionPlanDoc {
  return Boolean(doc?.path?.trim());
}

export function planDocRevision(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function isPlanDocApproved(doc: SessionPlanDoc | null | undefined): boolean {
  return Boolean(doc?.revision && doc.approvedRevision === doc.revision);
}

export function approvePlanDoc(doc: SessionPlanDoc): SessionPlanDoc {
  const { approvalPending: _pending, executionRequestedRevision: _requested, ...rest } = doc;
  return { ...rest, ...(doc.revision ? { approvedRevision: doc.revision, approvedAt: Date.now() } : {}) };
}

/** A bare, explicit go-ahead for the current task, never a question or quoted instruction. */
export function isPlanExecutionRequest(text: string): boolean {
  return /^(?:(?:ok|okay|好的?|可以|同意|批准|确认|没问题)[,，。.!！\s]*)*(?:开工|开始(?:落地(?:修改)?|实现|实施|开发|执行)|(?:按|按照)(?:这个|这份|该|上述|以上)?(?:方案|计划)(?:开始)?(?:实现|实施|开发|执行)|(?:implement|execute)(?:\s+the)?\s+plan|go\s+ahead)(?:吧|即可)?[。.!！\s]*$/i.test(text.trim());
}

/** Copy planDoc with approvalPending set/cleared (presentation only). */
export function withPlanDocApprovalPending(
  doc: SessionPlanDoc | null | undefined,
  pending: boolean,
): SessionPlanDoc | null {
  if (!hasPlanDoc(doc)) return null;
  if (doc.approvalPending === pending) return doc;
  if (!pending) {
    const { approvalPending: _drop, ...rest } = doc;
    void _drop;
    return rest;
  }
  return { ...doc, approvalPending: true };
}

function parseStagedPlan(
  raw: unknown,
): SessionPlanDoc["stagedPlan"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.title !== "string" || !o.title.trim()) return undefined;
  if (typeof o.updatedAt !== "number" || !Number.isFinite(o.updatedAt)) {
    return undefined;
  }
  if (!Array.isArray(o.steps) || o.steps.length < 2) return undefined;
  const steps: Array<string | { title: string; dependsOn?: string[] }> = [];
  for (const step of o.steps) {
    if (typeof step === "string" && step.trim()) {
      steps.push(step.trim());
      continue;
    }
    if (!step || typeof step !== "object" || Array.isArray(step)) continue;
    const title = (step as { title?: unknown }).title;
    if (typeof title !== "string" || !title.trim()) continue;
    const dependsOnRaw = (step as { dependsOn?: unknown }).dependsOn;
    const dependsOn = Array.isArray(dependsOnRaw)
      ? dependsOnRaw.filter(
          (id): id is string => typeof id === "string" && id.trim().length > 0,
        )
      : undefined;
    steps.push(
      dependsOn && dependsOn.length > 0
        ? { title: title.trim(), dependsOn }
        : { title: title.trim(), ...(dependsOn ? { dependsOn: [] } : {}) },
    );
  }
  if (steps.length < 2) return undefined;
  return {
    title: o.title.trim(),
    steps,
    updatedAt: o.updatedAt,
  };
}

export function parseSessionPlanDocJson(
  raw: string | null | undefined,
): SessionPlanDoc | null {
  if (raw == null || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const o = parsed as Record<string, unknown>;
    if (
      typeof o.path !== "string" ||
      !o.path.trim() ||
      typeof o.summary !== "string" ||
      typeof o.updatedAt !== "number"
    ) {
      return null;
    }
    const staged = parseStagedPlan(o.stagedPlan);
    return {
      path: o.path.trim(),
      summary: o.summary.trim().slice(0, PLAN_DOC_SUMMARY_MAX),
      updatedAt: o.updatedAt,
      ...(typeof o.revision === "string" && /^[a-f0-9]{64}$/.test(o.revision) ? { revision: o.revision } : {}),
      ...(typeof o.reviewedRevision === "string" && /^[a-f0-9]{64}$/.test(o.reviewedRevision) ? { reviewedRevision: o.reviewedRevision } : {}),
      ...(typeof o.approvedRevision === "string" && /^[a-f0-9]{64}$/.test(o.approvedRevision) ? { approvedRevision: o.approvedRevision } : {}),
      ...(typeof o.approvedAt === "number" && Number.isFinite(o.approvedAt) ? { approvedAt: o.approvedAt } : {}),
      ...(typeof o.executionRequestedRevision === "string" && /^[a-f0-9]{64}$/.test(o.executionRequestedRevision) ? { executionRequestedRevision: o.executionRequestedRevision } : {}),
      ...(o.approvalPending === true ? { approvalPending: true } : {}),
      ...(staged ? { stagedPlan: staged } : {}),
    };
  } catch {
    return null;
  }
}

/** Safe filename slug from a title / phrase. */
export function slugifyPlanDocTitle(title: string): string {
  const raw = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return raw || "plan";
}

export function formatPlanDocDate(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

/** Absolute path: {workspace}/docs/plans/{yyyyMMdd}-{slug}.md */
export function buildPlanDocAbsolutePath(
  workspacePath: string,
  title: string,
  now = new Date(),
): string {
  const name = `${formatPlanDocDate(now)}-${slugifyPlanDocTitle(title)}.md`;
  return join(planDocDirAbsolute(workspacePath), name);
}

/**
 * True when absolutePath resolves under {workspace}/docs/plans/ and is a .md file.
 */
export function isUnderPlanDocDir(
  workspacePath: string,
  absolutePath: string,
): boolean {
  const root = planDocDirAbsolute(workspacePath);
  const abs = resolve(absolutePath);
  const rel = relative(root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  if (rel.includes("..")) return false;
  return abs.toLowerCase().endsWith(".md");
}

export function clipPlanDocSummary(summary: string): string {
  return summary.trim().slice(0, PLAN_DOC_SUMMARY_MAX);
}

/** First `# ` heading text — fallback summary when editing without one. */
export function planDocHeadingSummary(content: string): string | null {
  const match = /^#[ \t]+(.+?)\s*$/m.exec(content);
  const text = match?.[1]?.trim();
  if (!text) return null;
  return clipPlanDocSummary(text);
}

export function displayPlanDocPath(absolutePath: string): string {
  return absolutePath.split(sep).join("/");
}
