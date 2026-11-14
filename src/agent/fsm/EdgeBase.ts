import type { EdgeEvalArgs } from "./types.js";

export type EdgeBaseOptions = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};

/**
 * Base class for transitions between Nodes.
 * Hybrid model: subclasses (EdgeAlways, EdgeWhen, …) + configurable params at hydrate.
 * Eval is read-only and returns boolean only — no context patches.
 */
export abstract class EdgeBase {
  abstract readonly type: string;
  readonly id: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;

  constructor(options: EdgeBaseOptions) {
    this.id = options.id;
    this.fromNodeId = options.fromNodeId;
    this.toNodeId = options.toNodeId;
  }

  /** Unified entrypoint — read-only; must not mutate turnContext / nodeContext. */
  abstract Eval(args: EdgeEvalArgs): boolean;
}
