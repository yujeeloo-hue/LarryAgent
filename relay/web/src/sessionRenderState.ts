/**
 * Render-relevance fingerprint for conversation snapshots.
 *
 * Idle resyncs fire in bursts after a turn (done + status:idle staggered
 * retries [400,1000,1600]ms, plus plan events and resubscribes). Each
 * loadSession rebuilds the whole conversation view and re-pins the scroll
 * bottom — when the snapshot content did not actually change between
 * retries, the view visibly bounces several times. This module derives a
 * cheap fingerprint of everything renderConvView consumes from a session
 * so unchanged snapshots skip the rebuild entirely (scroll position is
 * never touched; DOM nodes survive).
 *
 * The fingerprint must cover EVERY session field renderConvView reads for
 * DOM output (transcript, status surfaces, composer state, plan bar,
 * pending ask). Anything new consumed there has to be added here — the
 * module docblock on sessionRenderFingerprint() is the checklist.
 */
import type { Session } from "./types.js";

/** Signature of one message part — rendered-shape only (see partSig). */
function partSig(part: unknown): string {
  const p = part as Record<string, unknown>;
  switch (p?.type) {
    case "text":
      return `t:${p.text ?? ""}#${p.edited ? 1 : 0}${p.error ? 1 : 0}`;
    case "reasoning":
      return `r:${p.text ?? ""}#${p.durationMs ?? 0}#${p.tokenCount ?? 0}`;
    case "tool_call":
      return `c:${p.id}|${p.name}|${p.status}|${p.argumentsRaw ?? ""}|${JSON.stringify(p.arguments ?? {})}`;
    case "tool_result":
      return `x:${p.toolCallId}|${p.returnCode ?? 0}|${JSON.stringify(p.content ?? [])}`;
    case "attachment":
      return `a:${p.uri}|${p.name ?? ""}|${p.mimeType ?? ""}`;
    case "context_compaction":
      return `f:${p.id}|${p.summary ?? ""}|${p.usedTokensBefore ?? 0}|${p.usedTokensAfter ?? 0}`;
    case "context_clear":
      return `w:${p.id}`;
    case "hosted_tool":
      return `h:${p.id}|${p.name}|${p.status}|${JSON.stringify(p.item ?? {})}`;
    case "model_response":
      // Provider metadata row (model switcher) — identity only.
      return `m:${p.providerScope}|${p.responseId}|${p.stored ? 1 : 0}`;
    default:
      // Unknown part kind: stable- stringify whole so a new part type
      // never silently fails to invalidate.
      return `?:${JSON.stringify(partSigStable(p))}`;
  }
}

/** Order-normalized JSON so key order never fakes a change. */
function partSigStable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(partSigStable);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = partSigStable(src[key]);
    return out;
  }
  return value;
}

function messageSig(msg: Record<string, unknown>): string {
  const parts = Array.isArray(msg.parts) ? (msg.parts as unknown[]) : [];
  return `${msg.role}|${msg.id}|${parts.map(partSig).join(",")}`;
}

function planSig(plan: Session["plan"], sessionPlanDoc: Session["planDoc"]): string {
  if (!plan) return sessionPlanDoc ? `#|${docSig(sessionPlanDoc as DocLike)}` : "-";
  const steps = plan.steps
    .map((s) => `${s.id}:${s.title}:${s.status}:${(s.dependsOn ?? []).join(">")}`)
    .join(",");
  // Approval chrome can also ride Session.planDoc alone (Session.plan link
  // only carries path+summary; complete_plan clears Session.planDoc but not
  // the link) — fold both into the signature.
  const doc = (sessionPlanDoc ?? plan.planDoc) as DocLike | null | undefined;
  return `${plan.id}|${plan.status}|${steps}|${plan.cardVisible ? 1 : 0}|${plan.updatedAt}|${docSig(doc ?? null)}`;
}

type DocLike = Record<string, unknown>;

/** Plan-doc approval state — Approve/Discard chrome rides the full doc. */
function docSig(doc: DocLike | null): string {
  if (!doc) return "-";
  return [
    String(doc.path ?? ""),
    String(doc.summary ?? ""),
    String(doc.updatedAt ?? ""),
    String(doc.revision ?? ""),
    String(doc.approvedRevision ?? ""),
    doc.approvalPending ? "1" : "0",
  ].join("|");
}

/**
 * Fingerprint of everything renderConvView renders from a session.
 *
 * Checklist (renderConvView reads):
 *  - transcript: messages[].parts (text/reasoning/tool_call/tool_result/
 *    attachment/context markers/hosted tool/model response meta)
 *  - status surfaces: status, progressText (statusPill label)
 *  - composer: reasoningEffort, composerInfinite (toolbar initial state)
 *  - provider: providerId, model (fallback label)
 *  - plan bar: plan (steps + planDoc link) AND Session.planDoc approval state
 *  - ask panel: pendingUserAsk (requestId identity)
 * Deliberately NOT included: contextUsage (live gauge is event-driven and
 * snapshot-merged separately in loadSession), timestamps that never render
 * (createdAt), title (conv head — rendered, but title edits outside a turn
 * are rare; sessions list carries them. Include later if head drift shows).
 */
export function sessionRenderFingerprint(session: Session): string {
  const msgs = Array.isArray(session.messages) ? session.messages : [];
  return [
    session.id,
    session.status,
    session.progressText ?? "",
    session.reasoningEffort ?? "",
    session.composerInfinite == null ? "" : String(session.composerInfinite),
    session.providerId ?? "",
    session.model ?? "",
    planSig(session.plan, session.planDoc),
    session.pendingUserAsk?.requestId ?? "",
    msgs.length.toString(),
    ...msgs.map((m) => messageSig(m as unknown as Record<string, unknown>)),
  ].join("\n");
}

/**
 * Per-view render-relevance state: the fingerprint of the snapshot that
 * produced the CURRENT DOM. `null` = next render always rebuilds (fresh
 * view, session switch, structural reset).
 */
export class RenderRelevance {
  private fp: string | null = null;

  /** Record the fingerprint after a view was (re)built from this snapshot. */
  rendered(snapshot: Session): void {
    this.fp = sessionRenderFingerprint(snapshot);
  }

  /** Forget the current view — force the next snapshot to rebuild. */
  reset(): void {
    this.fp = null;
  }

  /** True when the DOM already reflects this exact snapshot. */
  matches(snapshot: Session): boolean {
    return this.fp !== null && this.fp === sessionRenderFingerprint(snapshot);
  }
}
