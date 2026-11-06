import { EdgeBase, type EdgeBaseOptions } from "../EdgeBase.js";
import type { EdgeEvalArgs } from "../types.js";

/** Plain route — Eval always true. Use when a Node has exactly one outgoing edge. */
export class EdgeAlways extends EdgeBase {
  readonly type = "EdgeAlways";

  constructor(options: EdgeBaseOptions) {
    super(options);
  }

  Eval(_args: EdgeEvalArgs): boolean {
    return true;
  }
}
