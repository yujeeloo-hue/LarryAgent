import type { Session } from "./types.js";

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
      return `m:${p.providerScope}|${p.responseId}|${p.stored ? 1 : 0}`;
    default:
      return `?:${JSON.stringify(partSigStable(p))}`;
  }
}

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
  const doc = (sessionPlanDoc ?? plan.planDoc) as DocLike | null | undefined;
  return `${plan.id}|${plan.status}|${steps}|${plan.cardVisible ? 1 : 0}|${plan.updatedAt}|${docSig(doc ?? null)}`;
}

type DocLike = Record<string, unknown>;

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
    Boolean(session.pendingUserAsk?.handoffQrPng),
    msgs.length.toString(),
    ...msgs.map((m) => messageSig(m as unknown as Record<string, unknown>)),
  ].join("\n");
}

export class RenderRelevance {
  private fp: string | null = null;

  rendered(snapshot: Session): void {
    this.fp = sessionRenderFingerprint(snapshot);
  }

  reset(): void {
    this.fp = null;
  }

  matches(snapshot: Session): boolean {
    return this.fp !== null && this.fp === sessionRenderFingerprint(snapshot);
  }
}
