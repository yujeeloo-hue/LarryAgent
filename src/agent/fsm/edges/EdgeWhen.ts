import { hasOpenPlanSteps } from "../../../session/plan.js";
import { EdgeBase, type EdgeBaseOptions } from "../EdgeBase.js";
import { compareTyped } from "../compareValues.js";
import type { EdgeEvalArgs, EdgeWhenParams } from "../types.js";

export type EdgeWhenOptions = EdgeBaseOptions & {
  /** Injected at hydrate — must not mutate contexts. */
  predicate: (args: EdgeEvalArgs) => boolean;
};

/**
 * Conditional edge. Predicate is supplied by registry hydrate from config params
 * (e.g. `{ turnKey, equals }`) or a custom factory.
 */
export class EdgeWhen extends EdgeBase {
  readonly type = "EdgeWhen";
  private readonly predicate: (args: EdgeEvalArgs) => boolean;

  constructor(options: EdgeWhenOptions) {
    super(options);
    this.predicate = options.predicate;
  }

  Eval(args: EdgeEvalArgs): boolean {
    return this.predicate(args) === true;
  }
}

function readEdgeValue(
  args: EdgeEvalArgs,
  turnKey: string,
  source: "turn" | "node" | "session",
): unknown {
  if (source === "node") return args.nodeContext[turnKey];
  if (source === "session") {
    const session = args.session as Record<string, unknown> | undefined;
    return session?.[turnKey];
  }
  return args.turnContext[turnKey];
}

function unlessNodeKeyBlocks(
  args: EdgeEvalArgs,
  unlessNodeKey: string | undefined,
): boolean {
  if (!unlessNodeKey) return false;
  const raw = args.nodeContext[unlessNodeKey];
  return typeof raw === "string" && raw.trim().length > 0;
}

/**
 * Built-in hydrate helper: match `turnKey === equals`.
 * Default source `"turn"` reads turnContext; `"node"` reads nodeContext;
 * `"session"` reads Host session fields (e.g. phase).
 */
export function edgeWhenTurnEqualsPredicate(
  turnKey: string,
  equals: unknown,
  source: "turn" | "node" | "session" = "turn",
  options: {
    unlessNodeKey?: string;
    requireIncompletePlan?: boolean;
  } = {},
): (args: EdgeEvalArgs) => boolean {
  return (args) => {
    if (unlessNodeKeyBlocks(args, options.unlessNodeKey)) return false;
    if (
      options.requireIncompletePlan &&
      !hasOpenPlanSteps(args.session?.plan ?? null)
    ) {
      return false;
    }
    return readEdgeValue(args, turnKey, source) === equals;
  };
}

/**
 * Built-in hydrate helper: pick the predicate from full EdgeWhen params.
 * Typed params (`type`/`operator`/`value`) route through the shared
 * comparator (compareValues.ts); comparison errors eval to `false` — the
 * node's no-match handling (selfLoop / error) surfaces the problem.
 * Without typed params this is the legacy strict-equality predicate.
 */
export function edgeWhenPredicateFromParams(
  params: EdgeWhenParams,
): (args: EdgeEvalArgs) => boolean {
  const source = params.source ?? "turn";
  const extras = {
    ...(typeof params.unlessNodeKey === "string" && params.unlessNodeKey.trim()
      ? { unlessNodeKey: params.unlessNodeKey.trim() }
      : {}),
    ...(params.requireIncompletePlan === true
      ? { requireIncompletePlan: true }
      : {}),
  };
  const typed =
    params.operator !== undefined ||
    params.type !== undefined ||
    params.value !== undefined;
  if (!typed) {
    return edgeWhenTurnEqualsPredicate(
      params.turnKey,
      params.equals,
      source,
      extras,
    );
  }
  const type = params.type;
  const operator = params.operator;
  if (!type || !operator) {
    // Malformed typed params — validateFSMGraphConfig rejects at authoring time.
    return () => false;
  }
  const label = `EdgeWhen(${params.turnKey})`;
  return (args) => {
    if (unlessNodeKeyBlocks(args, extras.unlessNodeKey)) return false;
    if (
      extras.requireIncompletePlan &&
      !hasOpenPlanSteps(args.session?.plan ?? null)
    ) {
      return false;
    }
    const out = compareTyped(
      type,
      operator,
      readEdgeValue(args, params.turnKey, source),
      params.value,
      label,
    );
    return out.ok ? out.met : false;
  };
}
