import type { RoleIterationSpec } from "../../roles/types.js";
import { planFrontierLines } from "../../roles/overlays.js";
import { hasPlanDoc } from "../../../session/planDoc.js";
import { getSessionPhase } from "../../../session/sessionPhase.js";
import { joinOverlayParts } from "../../turnHost/phaseOverlayWire.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { roleContextOf } from "./hostBridge.js";
import {
  NodeActionStubBase,
  stringParam,
} from "./NodeActionStubBase.js";
import { formatBlackboardValue } from "./NodeActionReadBlackboard.js";

/**
 * Prompt inject — single-source prompt block.
 * One action = one source: a visit note, the FSM route guide, or a live
 * session/state field. Placement chooses Bucket0 system vs trailing overlay;
 * frequency chooses every visit vs first entry to this node in the turn.
 */
export const NodeActionPromptInjectSchema: FsmParamsSchema = {
  type: "object",
  title: "Prompt inject",
  description:
    "One prompt block from a single source (note, route guide, or live field). Mount several in a row — action order is the block order.",
  "x-llmDescription": "Append one prompt block to the round. params: source note | routeGuide | plan | planDoc | pendingPlanDraft | phase | blackboard (plus key/scope/label for blackboard, note, routeGuide rows); placement overlay (default; frequency everyRound | oncePerNode) or system (Bucket0, every round). Mount several in a row — action order is block order.",
  details: `Appends one block to this visit's prompt. Placement: overlay (default) → trailing wire-only user after the conversation (live fields: plan / planDoc / phase); system → Bucket0 extra system after AGENT / plan-role markdown (stable policy like routeGuide). Frequency applies only to overlay: everyRound (default) re-injects each visit including self-loops; oncePerNode injects only the first entry to this nodeId in the turn. System placement always re-injects every round (frequency is ignored / hidden in the editor).

Sources: note (brief text; role descriptions belong on Prepare role), routeGuide ("## FSM routes" … — prefer placement=system), plan (active-plan frontier), planDoc (doc path + summary), pendingPlanDraft (title + themes), phase (session blackboard key "phase" — prefer placement=system), blackboard (session/turn blackboard key as "[Blackboard — key]\\nvalue"). Live plan fields stay on the overlay for prompt-cache; routeGuide / phase default to Bucket0 via migration and builtins.

Overlay merges into iterationSpec.phaseOverlay; system merges into iterationSpec.systemInject (joinOverlayParts keeps earlier blocks). A minimal agent spec is created when Prepare role has not run on this visit. Mounting the same source twice on one visit is a no-op (nodeContext.injectedSources). No-op when the source resolves empty. Replaces the former multi-source BuildNodeOverlay (migrations expand it into this sequence).`,
  additionalProperties: false,
  properties: {
    source: {
      type: "string",
      enum: [
        "note",
        "routeGuide",
        "plan",
        "planDoc",
        "pendingPlanDraft",
        "phase",
        "blackboard",
      ],
      default: "note",
      title: "Source",
      "x-ui": "select",
      "x-enumLabels": {
        note: "Visit note",
        routeGuide: "FSM route guide",
        plan: "Live · plan frontier",
        planDoc: "Live · plan doc",
        pendingPlanDraft: "Live · pending plan draft",
        phase: "Live · session blackboard phase (system)",
        blackboard: "Live · blackboard",
      },
    },
    placement: {
      type: "string",
      enum: ["overlay", "system"],
      default: "overlay",
      title: "Placement",
      description:
        "overlay = trailing wire-only user after the conversation; system = Bucket0 system after AGENT.",
      "x-ui": "select",
      "x-enumLabels": {
        overlay: "Overlay (trailing)",
        system: "System (Bucket0)",
      },
    },
    frequency: {
      type: "string",
      enum: ["everyRound", "oncePerNode"],
      default: "everyRound",
      title: "Frequency",
      description:
        "Overlay only. everyRound = each node visit (including self-loops); oncePerNode = first entry to this node in the turn. Hidden when Placement is System (always every round).",
      "x-ui": "select",
      "x-enumLabels": {
        everyRound: "Every round",
        oncePerNode: "First node entry this turn",
      },
      "x-showWhen": { placement: "overlay" },
    },
    note: {
      type: "string",
      title: "Visit note",
      description:
        "Brief prompt-only note. Role descriptions belong on Prepare role — with everyRound they would repeat each self-loop.",
      "x-ui": "collapsible-textarea",
      "x-showWhen": { source: "note" },
    },
    routeGuide: {
      type: "array",
      title: "Route guide",
      description:
        "Prompt-only rows: when (condition) → fsm_route event key (must match RouteTo).",
      items: { type: "object" },
      "x-ui": "route-guide",
      "x-showWhen": { source: "routeGuide" },
    },
    key: {
      type: "string",
      title: "Blackboard key",
      description: "Blackboard key to read (session or turn scope).",
      "x-ui": "text",
      "x-showWhen": { source: "blackboard" },
    },
    scope: {
      type: "string",
      enum: ["turn", "session"],
      default: "session",
      title: "Blackboard scope",
      "x-ui": "select",
      "x-enumLabels": { turn: "Turn", session: "Session" },
      "x-showWhen": { source: "blackboard" },
    },
    label: {
      type: "string",
      title: "Overlay heading",
      description: "Optional heading inside the block; defaults to the key.",
      "x-ui": "text",
      "x-showWhen": { source: "blackboard" },
    },
  },
};

type InjectSource =
  | "note"
  | "routeGuide"
  | "plan"
  | "planDoc"
  | "pendingPlanDraft"
  | "phase"
  | "blackboard";

type InjectPlacement = "overlay" | "system";
type InjectFrequency = "everyRound" | "oncePerNode";

const SOURCES: ReadonlySet<string> = new Set([
  "note",
  "routeGuide",
  "plan",
  "planDoc",
  "pendingPlanDraft",
  "phase",
  "blackboard",
]);

const PROMPT_INJECTED_ONCE_KEY = "promptInjectedOnce";

function linesFromPlanDoc(
  planDoc: ReturnType<typeof roleContextOf>["session"]["planDoc"],
): string[] {
  if (!hasPlanDoc(planDoc)) return [];
  return [
    `Plan doc: ${planDoc.path}`,
    `Summary: ${planDoc.summary}`,
    ...(planDoc.revision ? [`Revision: ${planDoc.revision}`] : []),
    ...(planDoc.revision && planDoc.approvedRevision === planDoc.revision ? ["Current revision approved."] : []),
    ...(planDoc.revision && planDoc.executionRequestedRevision === planDoc.revision
      ? ["The user explicitly requested implementation of this revision. Review it without repeating settled decisions or bookkeeping-only rewrites. If no substantive change is needed, call ready to honor that request; changing the document invalidates it."] : []),
  ];
}

function linesFromPendingDraft(
  pending: ReturnType<typeof roleContextOf>["state"]["pendingPlanDraft"],
): string[] {
  if (!pending || pending.steps.length === 0) return [];
  return [
    `Cover in the document: "${pending.title}"`,
    `Themes: ${pending.steps.join("; ")}`,
  ];
}

function linesFromPhase(
  phase: ReturnType<typeof roleContextOf>["session"]["phase"],
): string[] {
  if (typeof phase !== "string" || !phase.trim()) return [];
  return [`Phase: ${phase.trim()}`];
}

function linesFromRouteGuide(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const rows: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const when = typeof (item as { when?: unknown }).when === "string"
      ? (item as { when: string }).when.trim()
      : "";
    const routeTo =
      typeof (item as { routeTo?: unknown }).routeTo === "string"
        ? (item as { routeTo: string }).routeTo.trim()
        : "";
    if (!when || !routeTo) continue;
    rows.push(`- When ${when}: call fsm_route with route="${routeTo}"`);
  }
  if (rows.length === 0) return [];
  return ["## FSM routes", ...rows];
}

function onceKey(
  nodeId: string | undefined,
  placement: InjectPlacement,
  guardKey: string,
): string {
  return `${nodeId ?? "_"}:${placement}:${guardKey}`;
}

function patchInjectedSpec(
  args: NodeActionExecArgs,
  block: string,
  guardKey: string,
  placement: InjectPlacement,
  markOnceKey: string | null,
): NodeActionExecResult {
  const injectedSources = {
    ...((args.nodeContext.injectedSources as Record<string, true> | undefined) ??
      {}),
    [guardKey]: true,
  };

  const turnContextPatch =
    markOnceKey != null
      ? {
          [PROMPT_INJECTED_ONCE_KEY]: {
            ...((args.turnContext[PROMPT_INJECTED_ONCE_KEY] as
              | Record<string, true>
              | undefined) ?? {}),
            [markOnceKey]: true as const,
          },
        }
      : undefined;

  const raw = args.nodeContext.iterationSpec;
  if (!raw || typeof raw !== "object") {
    const iterationSpec: RoleIterationSpec = {
      roleKind: "agent",
      personaLabel: "AGENT",
      roleSystemPrompt: "",
      includeSkills: false,
      ...(placement === "system"
        ? { systemInject: block }
        : { phaseOverlay: block }),
    };
    return {
      status: "continue",
      ...(turnContextPatch ? { turnContextPatch } : {}),
      nodeContextPatch: {
        injectedSources,
        iterationSpec,
      },
    };
  }

  const spec = raw as RoleIterationSpec;
  const iterationSpec: RoleIterationSpec =
    placement === "system"
      ? {
          ...spec,
          systemInject: joinOverlayParts(spec.systemInject, block),
        }
      : {
          ...spec,
          phaseOverlay: joinOverlayParts(spec.phaseOverlay, block),
        };

  return {
    status: "continue",
    ...(turnContextPatch ? { turnContextPatch } : {}),
    nodeContextPatch: {
      injectedSources,
      iterationSpec,
    },
  };
}

export class NodeActionPromptInject extends NodeActionStubBase {
  readonly type = "NodeActionPromptInject";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const rawSource = stringParam(this.params, "source", "note") ?? "note";
    const source = (SOURCES.has(rawSource) ? rawSource : "note") as InjectSource;

    const placementRaw = stringParam(this.params, "placement", "overlay");
    const placement: InjectPlacement =
      placementRaw === "system" ? "system" : "overlay";

    // System placement always rewrites Bucket0 each visit (stable policy must
    // stay on the wire every round). Frequency is overlay-only.
    const frequencyRaw = stringParam(this.params, "frequency", "everyRound");
    const frequency: InjectFrequency =
      placement === "system"
        ? "everyRound"
        : frequencyRaw === "oncePerNode"
          ? "oncePerNode"
          : "everyRound";

    // Per-visit same-source guard: a second mount of the same source on one
    // node is a no-op (nodeContext is rebuilt per node visit, so self-loop
    // rounds always re-inject unless frequency=oncePerNode). Blackboard
    // guards per scope+key so multiple keys can be mounted in one node.
    const scope =
      stringParam(this.params, "scope", "session") === "turn" ? "turn" : "session";
    const blackboardKey = stringParam(this.params, "key")?.trim() ?? "";
    const guardKey =
      source === "blackboard" ? `blackboard:${scope}:${blackboardKey}` : source;

    if (frequency === "oncePerNode") {
      const key = onceKey(args.nodeId, placement, guardKey);
      const onceMap = args.turnContext[PROMPT_INJECTED_ONCE_KEY] as
        | Record<string, true>
        | undefined;
      if (onceMap?.[key]) {
        return { status: "continue" };
      }
    }

    const injected = args.nodeContext.injectedSources as
      | Record<string, true>
      | undefined;
    if (injected?.[guardKey]) {
      return { status: "continue" };
    }

    let block = "";
    if (source === "note") {
      block = stringParam(this.params, "note")?.trim() ?? "";
    } else if (source === "routeGuide") {
      block = linesFromRouteGuide(this.params.routeGuide).join("\n");
    } else if (source === "blackboard") {
      if (blackboardKey) {
        const value =
          scope === "session"
            ? args.host?.blackboardGet?.(blackboardKey)
            : args.turnContext[blackboardKey];
        if (value !== undefined) {
          const heading =
            stringParam(this.params, "label")?.trim() || blackboardKey;
          block = `[Blackboard — ${heading}]\n${formatBlackboardValue(value)}`;
        }
      }
    } else if (args.host) {
      const ctx = roleContextOf(args.host, args.turnContext);
      if (source === "plan") {
        block = planFrontierLines(ctx.session.plan).join("\n");
      } else if (source === "planDoc") {
        block = linesFromPlanDoc(ctx.session.planDoc).join("\n");
      } else if (source === "pendingPlanDraft") {
        block = linesFromPendingDraft(ctx.state.pendingPlanDraft).join("\n");
      } else {
        block = linesFromPhase(getSessionPhase(ctx.session)).join("\n");
      }
    }

    if (!block) {
      return { status: "continue" };
    }

    const markOnceKey =
      frequency === "oncePerNode"
        ? onceKey(args.nodeId, placement, guardKey)
        : null;
    return patchInjectedSpec(args, block, guardKey, placement, markOnceKey);
  }
}
