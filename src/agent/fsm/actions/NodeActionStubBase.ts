import { NodeActionBase } from "../NodeActionBase.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";

/**
 * Step 3/4 Actions: without `args.host` only mutate TurnContext / NodeContext
 * (stub path for sample graphs). With Host, subclasses call real capabilities.
 */
export abstract class NodeActionStubBase extends NodeActionBase {
  protected readonly params: Record<string, unknown>;

  constructor(params: Record<string, unknown> = {}) {
    super();
    this.params = params;
  }

  abstract override readonly type: string;

  abstract override Exec(
    args: NodeActionExecArgs,
  ): NodeActionExecResult | Promise<NodeActionExecResult>;
}

export function boolParam(
  params: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const v = params[key];
  return typeof v === "boolean" ? v : fallback;
}

/** Prefer `key`, then `legacyKey`, then fallback (Exec-time safety net). */
export function boolParamPrefer(
  params: Record<string, unknown>,
  key: string,
  legacyKey: string,
  fallback: boolean,
): boolean {
  if (typeof params[key] === "boolean") return params[key] as boolean;
  if (typeof params[legacyKey] === "boolean") {
    return params[legacyKey] as boolean;
  }
  return fallback;
}

export function stringParam(
  params: Record<string, unknown>,
  key: string,
  fallback?: string,
): string | undefined {
  const v = params[key];
  if (typeof v === "string") return v;
  return fallback;
}

/** Prefer `key`, then `legacyKey`, then fallback. */
export function stringParamPrefer(
  params: Record<string, unknown>,
  key: string,
  legacyKey: string,
  fallback?: string,
): string | undefined {
  const v = params[key];
  if (typeof v === "string") return v;
  const legacy = params[legacyKey];
  if (typeof legacy === "string") return legacy;
  return fallback;
}

export function numberParam(
  params: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const v = params[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.trim());
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
