import { EdgeAlways } from "./edges/EdgeAlways.js";
import {
  EdgeWhen,
  edgeWhenPredicateFromParams,
} from "./edges/EdgeWhen.js";
import type { EdgeBase } from "./EdgeBase.js";
import { FSMConfigError } from "./FSMConfigError.js";
import type { NodeActionBase } from "./NodeActionBase.js";
import {
  LOOSE_PARAMS_SCHEMA,
  normalizeAndValidateParams,
  type FsmParamsSchema,
} from "./paramsSchema.js";
import type { EdgeWhenParams, FSMGraphEdgeConfig, NodeActionConfig } from "./types.js";
import { EDGE_TYPE_ALWAYS, EDGE_TYPE_WHEN } from "./constants.js";

export type NodeActionFactory = (
  params?: Record<string, unknown>,
) => NodeActionBase;

export type NodeActionRegistration = {
  type: string;
  paramsSchema: FsmParamsSchema;
  /** Pure semantic checks after schema defaults on current-format params. */
  validate?: (params: Readonly<Record<string, unknown>>, label: string) => void;
  /**
   * Pure ordered child description after parent defaults; never constructs Actions.
   * create must expose the supplied instances through getChildren, in this order.
   */
  describeChildren?: (
    params: Readonly<Record<string, unknown>>,
    label: string,
  ) => readonly NodeActionConfig[];
  create: (params: Record<string, unknown>, context: NodeActionCreationContext) => NodeActionBase;
};

export type NodeActionCreationContext = {
  /** Children prepared and constructed by this same registry. */
  readonly children: readonly NodeActionBase[];
};

/** Validated params and a deferred factory; preparing never constructs an Action. */
export type PreparedNodeAction = {
  readonly type: string;
  readonly label: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly paramsSchema: FsmParamsSchema;
  readonly children: readonly PreparedNodeAction[];
  create: () => NodeActionBase;
};

export type EdgeFactoryInput = {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  params?: Record<string, unknown>;
};

export type EdgeFactory = (input: EdgeFactoryInput) => EdgeBase;

export type EdgeRegistration = {
  type: string;
  paramsSchema: FsmParamsSchema;
  create: EdgeFactory;
};

type ActionEntry = {
  paramsSchema: FsmParamsSchema;
  validate?: NodeActionRegistration["validate"];
  describeChildren?: NodeActionRegistration["describeChildren"];
  create: NodeActionRegistration["create"];
};

type EdgeEntry = {
  paramsSchema: FsmParamsSchema;
  create: EdgeFactory;
};

/**
 * Action / Edge type → factory + paramsSchema registry.
 */
export class FSMRegistry {
  private readonly actions = new Map<string, ActionEntry>();
  private readonly edges = new Map<string, EdgeEntry>();

  /**
   * Preferred registration API (editor can read paramsSchema).
   */
  registerAction(registration: NodeActionRegistration): this;
  /** @deprecated Prefer object registration with paramsSchema. */
  registerAction(type: string, factory: NodeActionFactory): this;
  registerAction(
    typeOrReg: string | NodeActionRegistration,
    factory?: NodeActionFactory,
  ): this {
    if (typeof typeOrReg === "string") {
      const id = typeOrReg.trim();
      if (!id || !factory) {
        throw new FSMConfigError(
          "UNKNOWN_ACTION",
          "registerAction type must be non-empty",
        );
      }
      this.actions.set(id, {
        paramsSchema: LOOSE_PARAMS_SCHEMA,
        create: (params) => factory(params),
      });
      return this;
    }
    const id = typeOrReg.type.trim();
    if (!id) {
      throw new FSMConfigError(
        "UNKNOWN_ACTION",
        "registerAction type must be non-empty",
      );
    }
    this.actions.set(id, {
      paramsSchema: typeOrReg.paramsSchema,
      ...(typeOrReg.validate ? { validate: typeOrReg.validate } : {}),
      ...(typeOrReg.describeChildren ? { describeChildren: typeOrReg.describeChildren } : {}),
      create: typeOrReg.create,
    });
    return this;
  }

  registerEdge(registration: EdgeRegistration): this;
  registerEdge(type: string, factory: EdgeFactory): this;
  registerEdge(
    typeOrReg: string | EdgeRegistration,
    factory?: EdgeFactory,
  ): this {
    if (typeof typeOrReg === "string") {
      const id = typeOrReg.trim();
      if (!id || !factory) {
        throw new FSMConfigError(
          "UNKNOWN_EDGE",
          "registerEdge type must be non-empty",
        );
      }
      this.edges.set(id, {
        paramsSchema: LOOSE_PARAMS_SCHEMA,
        create: factory,
      });
      return this;
    }
    const id = typeOrReg.type.trim();
    if (!id) {
      throw new FSMConfigError(
        "UNKNOWN_EDGE",
        "registerEdge type must be non-empty",
      );
    }
    this.edges.set(id, {
      paramsSchema: typeOrReg.paramsSchema,
      create: typeOrReg.create,
    });
    return this;
  }

  registerActions(map: Record<string, NodeActionFactory>): this {
    for (const [type, factory] of Object.entries(map)) {
      this.registerAction(type, factory);
    }
    return this;
  }

  registerEdges(map: Record<string, EdgeFactory>): this {
    for (const [type, factory] of Object.entries(map)) {
      this.registerEdge(type, factory);
    }
    return this;
  }

  hasAction(type: string): boolean {
    return this.actions.has(type.trim());
  }

  hasEdge(type: string): boolean {
    return this.edges.has(type);
  }

  getActionParamsSchema(type: string): FsmParamsSchema {
    const canonical = type.trim();
    const entry = this.actions.get(canonical);
    if (!entry) {
      throw new FSMConfigError(
        "UNKNOWN_ACTION",
        `Unknown NodeAction type "${type}"`,
      );
    }
    return entry.paramsSchema;
  }

  getEdgeParamsSchema(type: string): FsmParamsSchema {
    const entry = this.edges.get(type);
    if (!entry) {
      throw new FSMConfigError(
        "UNKNOWN_EDGE",
        `Unknown Edge type "${type}"`,
      );
    }
    return entry.paramsSchema;
  }

  /**
   * Normalize and validate once, retaining the factory for later construction.
   */
  prepareAction(
    type: string,
    params: Record<string, unknown> | undefined,
    label: string,
  ): PreparedNodeAction {
    return this.prepareActionTree(type, params, label, 0);
  }

  private prepareActionTree(
    type: string,
    params: Record<string, unknown> | undefined,
    label: string,
    depth: number,
  ): PreparedNodeAction {
    // A recursive descriptor must fail with a configuration error, not overflow the stack.
    if (depth >= 64) {
      throw new FSMConfigError("INVALID_ACTION_PARAMS", `${label}: composite nesting exceeds 64 levels (possible recursive child description)`);
    }
    const canonical = type.trim();
    const entry = this.actions.get(canonical);
    if (!entry) {
      throw new FSMConfigError(
        "UNKNOWN_ACTION",
        `${label}: Unknown NodeAction type "${type}"`,
      );
    }
    const normalized = normalizeAndValidateParams(
      entry.paramsSchema,
      params,
      label,
    );
    entry.validate?.(normalized, label);
    const configs = entry.describeChildren ? entry.describeChildren(normalized, label) : [];
    if (!Array.isArray(configs)) {
      throw new FSMConfigError("INVALID_ACTION_PARAMS", `${label}: describeChildren must return an array`);
    }
    const children = Object.freeze(configs.map((config, index) => {
      const childLabel = `${label} / child #${index}`;
      if (!config || typeof config !== "object" || Array.isArray(config) ||
          typeof config.type !== "string" || !config.type.trim()) {
        throw new FSMConfigError("UNKNOWN_ACTION", `${childLabel}: child Action type must be a non-empty string`);
      }
      if (config.params !== undefined && (!config.params || typeof config.params !== "object" || Array.isArray(config.params))) {
        throw new FSMConfigError("INVALID_ACTION_PARAMS", `${childLabel} (${config.type}): params must be an object`);
      }
      return this.prepareActionTree(config.type, config.params, `${childLabel} (${config.type})`, depth + 1);
    }));
    return {
      type: canonical,
      label,
      params: normalized,
      paramsSchema: entry.paramsSchema,
      children,
      create: () => {
        const instances = children.map((child) => child.create());
        const action = entry.create(normalized, { children: instances });
        if (entry.describeChildren) {
          const mounted = action.getChildren();
          if (mounted.length !== instances.length || mounted.some((child, index) => child !== instances[index])) {
            throw new FSMConfigError("INVALID_ACTION_PARAMS", `${label}: composite must expose the children supplied by its registry in declared order`);
          }
        }
        return action;
      },
    };
  }

  /** Normalize, validate and construct a standalone Action. */
  createAction(
    type: string,
    params: Record<string, unknown> | undefined,
    label: string,
  ): NodeActionBase {
    return this.prepareAction(type, params, label).create();
  }

  createEdge(input: EdgeFactoryInput & { type: string }): EdgeBase {
    const entry = this.edges.get(input.type);
    if (!entry) {
      throw new FSMConfigError(
        "UNKNOWN_EDGE",
        `Unknown Edge type "${input.type}"`,
      );
    }
    const normalized = normalizeAndValidateParams(
      entry.paramsSchema,
      input.params,
      `Edge type "${input.type}"`,
    );
    return entry.create({
      id: input.id,
      fromNodeId: input.fromNodeId,
      toNodeId: input.toNodeId,
      params: normalized,
    });
  }

  /** @deprecated Prefer createAction */
  getActionFactory(type: string): NodeActionFactory {
    const canonical = type.trim();
    const entry = this.actions.get(canonical);
    if (!entry) {
      throw new FSMConfigError(
        "UNKNOWN_ACTION",
        `Unknown NodeAction type "${type}"`,
      );
    }
    return (params) =>
      this.createAction(type, params, `NodeAction type "${canonical}"`);
  }

  getEdgeFactory(type: string): EdgeFactory {
    return (input) => this.createEdge({ ...input, type });
  }

  listActionTypes(): string[] {
    return [...this.actions.keys()].sort();
  }

  listEdgeTypes(): string[] {
    return [...this.edges.keys()].sort();
  }

  /** Editor catalog: type + optional title/description + paramsSchema. */
  listActionCatalog(): Array<{
    type: string;
    title?: string;
    description?: string;
    paramsSchema: FsmParamsSchema;
  }> {
    return this.listActionTypes().map((type) => {
      const schema = this.getActionParamsSchema(type);
      return {
        type,
        ...(schema.title ? { title: schema.title } : {}),
        ...(schema.description ? { description: schema.description } : {}),
        paramsSchema: schema,
      };
    });
  }

  listEdgeCatalog(): Array<{ type: string; paramsSchema: FsmParamsSchema }> {
    return this.listEdgeTypes().map((type) => ({
      type,
      paramsSchema: this.getEdgeParamsSchema(type),
    }));
  }

  clone(): FSMRegistry {
    const next = new FSMRegistry();
    for (const [type, entry] of this.actions) {
      next.actions.set(type, entry);
    }
    for (const [type, entry] of this.edges) {
      next.edges.set(type, entry);
    }
    return next;
  }

  static createDefault(): FSMRegistry {
    const edgeAlwaysSchema: FsmParamsSchema = {
      type: "object",
      "x-llmDescription":
        "Always-true edge: the node's default exit when no conditional edge matches. No params.",
      additionalProperties: false,
      properties: {},
    };
    const edgeWhenSchema: FsmParamsSchema = {
      type: "object",
      additionalProperties: false,
      required: ["turnKey"],
      "x-llmDescription":
        "Conditional edge: taken when turnKey (required) matches equals under optional type int|float|string and operator (default ==). source turn (default) | node | session; unlessNodeKey skips when that node key is a non-empty string; requireIncompletePlan also demands an active plan with open steps.",
      properties: {
        turnKey: {
          type: "string",
          minLength: 1,
          title: "TurnContext key",
          "x-ui": "text",
        },
        equals: {
          title: "Equals value",
          "x-ui": "textarea",
        },
        source: {
          type: "string",
          enum: ["turn", "node", "session"],
          default: "turn",
          title: "Read from",
          description:
            "turn: turnContext[turnKey]. node: nodeContext[turnKey] (routeTarget, …). session: Host session fields (phase, …) for start-node phase resume.",
          "x-ui": "select",
          "x-enumLabels": {
            turn: "Turn context",
            node: "Node context",
            session: "Session",
          },
        },
        unlessNodeKey: {
          type: "string",
          minLength: 1,
          title: "Unless node key",
          description:
            "Skip this edge when nodeContext[key] is a non-empty string (e.g. routeTarget already set by Approve).",
          "x-ui": "text",
        },
        requireIncompletePlan: {
          type: "boolean",
          default: false,
          title: "Require incomplete plan",
          description:
            "When true, also require an active plan with open steps (executing→executor resume).",
          "x-ui": "toggle",
        },
      },
    };

    return new FSMRegistry()
      .registerEdge({
        type: EDGE_TYPE_ALWAYS,
        paramsSchema: edgeAlwaysSchema,
        create: ({ id, fromNodeId, toNodeId }) =>
          new EdgeAlways({ id, fromNodeId, toNodeId }),
      })
      .registerEdge({
        type: EDGE_TYPE_WHEN,
        paramsSchema: edgeWhenSchema,
        create: ({ id, fromNodeId, toNodeId, params }) => {
          const turnKey = params?.turnKey;
          if (typeof turnKey !== "string" || turnKey.length === 0) {
            throw new FSMConfigError(
              "INVALID_EDGE_PARAMS",
              "EdgeWhen hydrate requires params.turnKey (string)",
            );
          }
          const whenParams: EdgeWhenParams = { turnKey };
          if (params && "equals" in params) {
            whenParams.equals = params.equals;
          }
          if (
            params?.source === "node" ||
            params?.source === "session" ||
            params?.source === "turn"
          ) {
            whenParams.source = params.source;
          }
          if (
            typeof params?.unlessNodeKey === "string" &&
            params.unlessNodeKey.trim()
          ) {
            whenParams.unlessNodeKey = params.unlessNodeKey.trim();
          }
          if (params?.requireIncompletePlan === true) {
            whenParams.requireIncompletePlan = true;
          }
          if (
            typeof params?.type === "string" &&
            (params.type === "int" ||
              params.type === "float" ||
              params.type === "string")
          ) {
            whenParams.type = params.type;
          }
          if (typeof params?.operator === "string") {
            whenParams.operator = params.operator;
          }
          if (params && "value" in params) {
            whenParams.value = params.value;
          }
          return new EdgeWhen({
            id,
            fromNodeId,
            toNodeId,
            predicate: edgeWhenPredicateFromParams(whenParams),
          });
        },
      });
  }
}

export type FSMRegistries = {
  actions: Record<string, NodeActionFactory>;
  edges: Record<string, EdgeFactory>;
};

export function resolveRegistry(
  extra?: Partial<FSMRegistries> | FSMRegistry,
): FSMRegistry {
  if (extra instanceof FSMRegistry) {
    return extra;
  }
  const registry = FSMRegistry.createDefault();
  if (extra?.actions) {
    registry.registerActions(extra.actions);
  }
  if (extra?.edges) {
    registry.registerEdges(extra.edges);
  }
  return registry;
}

export function defaultEdgeId(edge: FSMGraphEdgeConfig, index: number): string {
  return edge.id?.trim() || `${edge.from}->${edge.to}#${index}`;
}
