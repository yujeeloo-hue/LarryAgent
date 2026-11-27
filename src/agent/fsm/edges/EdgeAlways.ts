import { EdgeBase, type EdgeBaseOptions } from "../EdgeBase.js";
import type { EdgeEvalArgs } from "../types.js";

export class EdgeAlways extends EdgeBase {
  readonly type = "EdgeAlways";

  constructor(options: EdgeBaseOptions) {
    super(options);
  }

  Eval(_args: EdgeEvalArgs): boolean {
    return true;
  }
}
