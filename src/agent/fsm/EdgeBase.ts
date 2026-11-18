import type { EdgeEvalArgs } from "./types.js";

export type EdgeBaseOptions = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
};

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

  abstract Eval(args: EdgeEvalArgs): boolean;
}
