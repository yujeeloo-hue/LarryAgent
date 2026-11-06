import type { DebugHoverValue } from "./DebugController.js";

const MAX_TREE_DEPTH = 32;

export type DebugHoverNode = {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  depth: number;
  ancestors: ReadonlySet<number>;
  expandable: boolean;
  terminalReason?: "cycle" | "max-depth";
};

type EvaluateHover = (expression: string) => Promise<DebugHoverValue | null>;
type ExpandVariable = (
  variablesReference: number,
) => Promise<DebugVariable[]>;

/** State, caching and traversal policy for the interactive debug hover. */
export class DebugHoverController {
  private readonly cache = new Map<number, Promise<DebugVariable[]>>();
  private epoch = 0;

  constructor(
    private readonly evaluateHover: EvaluateHover,
    private readonly expandVariable: ExpandVariable,
  ) {}

  async evaluate(expression: string): Promise<DebugHoverNode | null> {
    const epoch = ++this.epoch;
    this.cache.clear();
    const value = await this.evaluateHover(expression);
    if (!value || epoch !== this.epoch) return null;
    return this.node(
      {
        name: expression,
        value: value.result,
        ...(value.type ? { type: value.type } : {}),
        variablesReference: value.variablesReference,
      },
      0,
      new Set(),
    );
  }

  async expand(node: DebugHoverNode): Promise<DebugHoverNode[]> {
    if (!node.expandable) return [];
    let request = this.cache.get(node.variablesReference);
    if (!request) {
      request = this.expandVariable(node.variablesReference);
      this.cache.set(node.variablesReference, request);
    }
    try {
      const variables = await request;
      const ancestors = new Set(node.ancestors);
      ancestors.add(node.variablesReference);
      return variables.map((variable) =>
        this.node(variable, node.depth + 1, ancestors),
      );
    } catch (err) {
      this.cache.delete(node.variablesReference);
      throw err;
    }
  }

  invalidate(): void {
    this.epoch += 1;
    this.cache.clear();
  }

  private node(
    variable: DebugVariable,
    depth: number,
    ancestors: ReadonlySet<number>,
  ): DebugHoverNode {
    const reference = variable.variablesReference;
    const cycle = reference > 0 && ancestors.has(reference);
    const maxDepth = reference > 0 && depth >= MAX_TREE_DEPTH;
    return {
      name: variable.name,
      value: variable.value,
      ...(variable.type ? { type: variable.type } : {}),
      variablesReference: reference,
      depth,
      ancestors,
      expandable: reference > 0 && !cycle && !maxDepth,
      ...(cycle
        ? { terminalReason: "cycle" as const }
        : maxDepth
          ? { terminalReason: "max-depth" as const }
          : {}),
    };
  }
}
