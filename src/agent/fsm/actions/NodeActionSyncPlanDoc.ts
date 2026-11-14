import { resolve } from "node:path";
import { agentLogInfo } from "../../../logging/agentLog.js";
import { isPlanDocApproved, isPlanExecutionRequest, isUnderPlanDocDir, planDocRevision } from "../../../session/planDoc.js";
import { getSessionPhase } from "../../../session/sessionPhase.js";
import type { Session, SessionPlanDoc } from "../../../session/types.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type { NodeActionExecArgs, NodeActionExecResult } from "../types.js";
import { NodeActionStubBase, stringParam } from "./NodeActionStubBase.js";

export const NodeActionSyncPlanDocSchema: FsmParamsSchema = {
  type: "object",
  title: "Sync plan document",
  description: "Refresh the bound document revision and invalidate stale approval. Optionally adopt an explicit current-task document and capture a human execution request. Does not route.",
  "x-llmDescription": "Refresh the bound plan document revision by content hash: a changed doc loses review / approval markers (changedPhase optionally re-routes to review); a missing file clears the binding and phase. Optional adoptReferencedDoc, captureExecutionRequest, legacyApprovedPhases. Never routes.",
  details: `Reads the bound document through host.readPlanDocContent and compares its content hash with the stored revision. A changed document loses its review, approval and execution-request markers; changedPhase optionally selects the session phase for re-review. Missing files clear the document binding and phase so stale execution cannot resume.

adoptReferencedDoc permits one explicit workspace/docs/plans reference in the current user message, or one reference from the immediately preceding turn after a bare human go-ahead. It does not scan directories or older tasks. Adoption reads the existing file without rewriting it.

captureExecutionRequest recognizes explicit current-task implementation requests from trusted turnInput.userText. The request applies only to the unchanged revision and still requires review before execution. legacyApprovedPhases is an explicit migration rule for unversioned sessions; versioned documents never infer approval from phase. Emits diagnostic flags and logs, never a routeTarget.`,
  additionalProperties: false,
  properties: {
    changedPhase: { type: "string", description: "Session phase to write when the document changed or a referenced document is adopted." },
    legacyApprovedPhases: { type: "array", items: { type: "string" }, description: "Phases that prove an older unversioned document already passed approval. Versioned documents never infer approval from phase." },
    adoptReferencedDoc: { type: "boolean", default: false },
    captureExecutionRequest: { type: "boolean", default: false },
  },
};

/** Only current-message references, or the immediately preceding turn after a bare go-ahead. */
export function referencedPlanDocPaths(session: Session, userText: string): string[] {
  const root = session.workspacePath?.trim();
  if (!root) return [];
  const paths = new Set<string>();
  const add = (path: string): void => {
    const absolute = resolve(root, path);
    if (isUnderPlanDocDir(root, absolute)) paths.add(absolute);
  };
  const textPaths = (text: string): void => {
    for (const match of text.matchAll(/(?:[^\s`"'<>()[\]，。；：！？]*[\\/])?docs[\\/]plans[\\/][^\s`"'<>()[\]，。；：！？]*\.md/g)) add(match[0]);
  };
  textPaths(userText);
  if (paths.size > 0 || !isPlanExecutionRequest(userText)) return [...paths];
  const messages = session.messages;
  let start = messages.length - 1;
  while (start >= 0 && messages[start]?.role !== "user") start -= 1;
  const previousTurn = messages.slice(Math.max(0, start));
  const succeeded = new Set(previousTurn.flatMap(message => message.parts.flatMap(part =>
    part.type === "tool_result" && part.returnCode === 0 ? [part.toolCallId] : [],
  )));
  for (const message of previousTurn) {
    for (const part of message.parts) {
      if (part.type === "text") textPaths(part.text);
      if (part.type === "tool_call" && succeeded.has(part.id) &&
          ["write_file", "read_file", "patch"].includes(part.name) && typeof part.arguments.path === "string") add(part.arguments.path);
    }
  }
  return [...paths];
}

export class NodeActionSyncPlanDoc extends NodeActionStubBase {
  readonly type = "NodeActionSyncPlanDoc";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const host = args.host;
    if (!host) return { status: "continue" };
    const requested = this.params.captureExecutionRequest === true &&
      !args.turnInput?.controlIntent && isPlanExecutionRequest(args.turnInput?.userText ?? "");
    const changedPhase = stringParam(this.params, "changedPhase");
    let adopted = false;
    if (this.params.adoptReferencedDoc === true && host.adoptPlanDoc) {
      const paths = referencedPlanDocPaths(host.session, args.turnInput?.userText ?? "");
      if (paths.length === 1 && paths[0] !== host.session.planDoc?.path) {
        const planDoc = await host.adoptPlanDoc(paths[0]!, requested);
        if (planDoc) {
          host.applySessionPatch({ planDoc, ...(changedPhase ? { phase: changedPhase } : {}) });
          adopted = true;
        }
      }
    }
    const doc = host.session.planDoc;
    if (!doc) {
      agentLogInfo("fsm.plan_entry", { sessionId: host.session.id, reason: "no_document", executionRequested: requested });
      return { status: "continue", turnContextPatch: { planExecutionRequested: requested } };
    }
    // Stub/custom hosts without a file reader retain their existing phase behavior.
    const content = host.readPlanDocContent ? await host.readPlanDocContent(doc.path) : undefined;
    if (content === null || content?.trim() === "") {
      host.applySessionPatch({ planDoc: null, phase: null });
      agentLogInfo("fsm.plan_entry", { sessionId: host.session.id, reason: "document_unavailable", path: doc.path });
      return { status: "continue", turnContextPatch: { planDocChanged: true, planExecutionRequested: false } };
    }
    const revision = content === undefined ? doc.revision : planDocRevision(content);
    const changed = Boolean(doc.revision && revision !== doc.revision);
    const legacyPhases = Array.isArray(this.params.legacyApprovedPhases) ? this.params.legacyApprovedPhases : [];
    const legacyApproved = !doc.revision && !doc.approvalPending && legacyPhases.includes(getSessionPhase(host.session));
    const next: SessionPlanDoc = changed
      ? { path: doc.path, summary: doc.summary, updatedAt: Date.now(), ...(revision ? { revision } : {}) }
      : { ...doc, ...(revision ? { revision } : {}) };
    if (legacyApproved && revision) next.approvedRevision = revision;
    if (!doc.revision && doc.approvalPending && revision) next.reviewedRevision = revision;
    if (requested && revision && !changed) next.executionRequestedRevision = revision;
    const approvalLost = Boolean(doc.revision && !isPlanDocApproved(next) && legacyPhases.includes(getSessionPhase(host.session)));
    host.applySessionPatch({ planDoc: next, ...((changed || approvalLost) && changedPhase ? { phase: changedPhase } : {}) });
    agentLogInfo("fsm.plan_entry", {
      sessionId: host.session.id,
      reason: changed ? "document_changed" : approvalLost ? "approval_missing" : adopted ? "document_adopted" : "document_present",
      path: next.path,
      revision,
      approved: Boolean(revision && next.approvedRevision === revision),
      executionRequested: Boolean(revision && next.executionRequestedRevision === revision),
    });
    return { status: "continue", turnContextPatch: { planDocChanged: changed, planExecutionRequested: requested && !changed } };
  }
}
