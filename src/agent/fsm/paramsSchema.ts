import { FSMConfigError } from "./FSMConfigError.js";

/** JSON Schema subset for editor + hydrate validation. */
export type FsmParamsPropertySchema = {
  type?: "string" | "boolean" | "integer" | "number" | "array" | "object";
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  minLength?: number;
  /** When type is array. */
  items?: {
    type: "string" | "object";
    minLength?: number;
    /** When items.type is object. */
    properties?: Record<string, FsmParamsPropertySchema>;
    required?: string[];
    additionalProperties?: boolean | { type: "string"; minLength?: number };
  };
  title?: string;
  description?: string;
  /**
   * LLM-facing help override for the fsm_graph catalog / describe
   * projections. Absent → fall back to `description`. The editor never
   * reads this key.
   */
  "x-llmDescription"?: string;
  /**
   * Editor widget hint. `pin-select` / `pin-map` options come from the same
   * Node's `pins[].name` (not from this schema's enum).
   * `collapsible-textarea`: string textarea hidden behind a one-line toggle —
   * collapsed by default (empty or not); expands on click, auto-collapses
   * again when the committed value is empty.
   */
      "x-ui"?:
    | "toggle"
    | "text"
    | "number"
    | "select"
    | "textarea"
    | "collapsible-textarea"
    | "string-list"
    | "pin-select"
    | "pin-map"
    | "route-bindings"
    | "text-pin-bindings"
    | "flag-pin-bindings"
    | "route-guide"
    | "object-fields"
    | "hidden";
  /** Optional display labels for `enum` values (editor select). */
  "x-enumLabels"?: Record<string, string>;
  /**
   * Show this field only when every listed param key equals the given value
   * (editor). Example: `{ "roleKind": "custom" }`.
   */
  "x-showWhen"?: Record<string, string>;
  /**
   * When type is object (legacy pin-map): each value must be a string pin name.
   */
  additionalProperties?: boolean | { type: "string"; minLength?: number };
  /** Nested object fields (e.g. structured action param groups). */
  properties?: Record<string, FsmParamsPropertySchema>;
  required?: string[];
};

export type FsmParamsSchema = {
  type: "object";
  /**
   * Top-level editor widget. `route-to` = unified mapping table; each row
   * chooses event vs blackboard source (persists to when[] / routes[]).
   */
  "x-ui"?: "route-to";
  /** Short editor label for this Action / Edge (catalog). */
  title?: string;
  /** Longer editor help for this Action / Edge (catalog). */
  description?: string;
  /**
   * LLM-facing one-line summary for the fsm_graph slim catalog and
   * describe_action / describe_edge output. Absent → fall back to
   * `description`. The editor never reads this key.
   */
  "x-llmDescription"?: string;
  /**
   * In-depth reference (catalog [?] panel + action hover tip, and the LLM
   * describe projection): what the Action does plus implementation notes
   * (host calls, patches, route events, guards). Audience-neutral plain
   * text; "\n\n" separates paragraphs.
   */
  details?: string;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, FsmParamsPropertySchema>;
  /**
   * Route events this Action may emit (scanned into RouteTo event
   * dropdowns on the same Node).
   */
  "x-emitsRouteEvents"?: string[];
};

export const EMPTY_PARAMS_SCHEMA: FsmParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

/** Allow any params (legacy / test helpers). */
export const LOOSE_PARAMS_SCHEMA: FsmParamsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply top-level defaults, then recursively validate declared fields.
 * Nested objects keep omitted fields so partial overrides remain partial.
 * Returns a new params object without mutating the input or schema defaults.
 */
export function normalizeAndValidateParams(
  schema: FsmParamsSchema,
  params: Record<string, unknown> | undefined,
  label: string,
): Record<string, unknown> {
  const input = params ?? {};
  if (!isPlainObject(input)) {
    throw new FSMConfigError(
      "INVALID_ACTION_PARAMS",
      `${label}: params must be an object`,
    );
  }

  return normalizeObjectParams(schema, input, label);
}

function normalizeObjectParams(
  schema: Pick<FsmParamsPropertySchema, "properties" | "required" | "additionalProperties">,
  input: Record<string, unknown>,
  label: string,
  parentPath = "",
): Record<string, unknown> {
  const paramPath = (key: string): string => parentPath ? `${parentPath}.${key}` : key;

  const properties = schema.properties ?? {};
  const out: Record<string, unknown> = { ...input };

  // Nested objects can be partial overrides (e.g. RoleRoundBuilder.prepareRole).
  // Filling their omitted defaults here would override the later role preset.
  if (!parentPath) {
    for (const [key, prop] of Object.entries(properties)) {
      if (!(key in out) && prop.default !== undefined) {
        out[key] = prop.default;
      }
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(out)) {
      if (!(key in properties)) {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: unknown param "${paramPath(key)}"`,
        );
      }
    }
  }

  for (const key of schema.required ?? []) {
    if (!(key in out) || out[key] === undefined) {
      throw new FSMConfigError(
        "INVALID_ACTION_PARAMS",
        `${label}: missing required param "${paramPath(key)}"`,
      );
    }
  }

  const valueSchema = schema.additionalProperties;
  if (valueSchema && typeof valueSchema === "object" && valueSchema.type === "string") {
    for (const [key, value] of Object.entries(out)) {
      if (typeof value !== "string") {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: param "${paramPath(key)}" must be a string`,
        );
      }
      if (valueSchema.minLength !== undefined && value.length < valueSchema.minLength) {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: param "${paramPath(key)}" shorter than minLength ${valueSchema.minLength}`,
        );
      }
    }
  }

  for (const [key, value] of Object.entries(out)) {
    const prop = properties[key];
    if (!prop) continue;
    const path = paramPath(key);
    let coerced = value;
    if (
      (prop.type === "integer" || prop.type === "number") &&
      typeof coerced === "string"
    ) {
      const trimmed = coerced.trim();
      if (trimmed.length > 0) {
        const n = Number(trimmed);
        if (Number.isFinite(n)) {
          coerced = prop.type === "integer" ? Math.trunc(n) : n;
          out[key] = coerced;
        }
      }
    }
    if (prop.enum && !prop.enum.includes(coerced)) {
      throw new FSMConfigError(
        "INVALID_ACTION_PARAMS",
        `${label}: param "${path}" must be one of ${JSON.stringify(prop.enum)}`,
      );
    }
    if (prop.type === "string") {
      if (typeof coerced !== "string") {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: param "${path}" must be a string`,
        );
      }
      if (prop.minLength !== undefined && coerced.length < prop.minLength) {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: param "${path}" shorter than minLength ${prop.minLength}`,
        );
      }
    } else if (prop.type === "boolean") {
      if (typeof coerced !== "boolean") {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: param "${path}" must be a boolean`,
        );
      }
    } else if (prop.type === "integer" || prop.type === "number") {
      if (
        typeof coerced !== "number" ||
        !Number.isFinite(coerced) ||
        (prop.type === "integer" && !Number.isInteger(coerced))
      ) {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: param "${path}" must be a ${prop.type}`,
        );
      }
      if (prop.minimum !== undefined && coerced < prop.minimum) {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: param "${path}" below minimum ${prop.minimum}`,
        );
      }
    } else if (prop.type === "array") {
      if (!Array.isArray(coerced)) {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: param "${path}" must be an array`,
        );
      }
      const itemType = prop.items?.type ?? "string";
      const normalizedItems = [...coerced];
      for (let i = 0; i < coerced.length; i++) {
        const item = coerced[i];
        const itemPath = `${path}[${i}]`;
        if (itemType === "string" && typeof item !== "string") {
          throw new FSMConfigError(
            "INVALID_ACTION_PARAMS",
            `${label}: param "${itemPath}" must be a string`,
          );
        }
        if (itemType === "string" && typeof item === "string" &&
            prop.items?.minLength !== undefined && item.length < prop.items.minLength) {
          throw new FSMConfigError(
            "INVALID_ACTION_PARAMS",
            `${label}: param "${itemPath}" shorter than minLength ${prop.items.minLength}`,
          );
        }
        if (
          itemType === "object" &&
          (typeof item !== "object" || item === null || Array.isArray(item))
        ) {
          throw new FSMConfigError(
            "INVALID_ACTION_PARAMS",
            `${label}: param "${itemPath}" must be an object`,
          );
        }
        if (itemType === "object" && prop.items && isPlainObject(item)) {
          normalizedItems[i] = normalizeObjectParams(prop.items, item, label, itemPath);
        }
      }
      out[key] = normalizedItems;
    } else if (prop.type === "object") {
      if (!isPlainObject(coerced)) {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: param "${path}" must be an object`,
        );
      }
      out[key] = normalizeObjectParams(prop, coerced, label, path);
    }
  }

  return out;
}
