import { FSMConfigError } from "./FSMConfigError.js";

export type FsmParamsPropertySchema = {
  type?: "string" | "boolean" | "integer" | "number" | "array" | "object";
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  minLength?: number;
  items?: {
    type: "string" | "object";
    minLength?: number;
    properties?: Record<string, FsmParamsPropertySchema>;
    required?: string[];
    additionalProperties?: boolean | { type: "string"; minLength?: number };
  };
  title?: string;
  description?: string;
  "x-llmDescription"?: string;
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
  "x-enumLabels"?: Record<string, string>;
  "x-showWhen"?: Record<string, string>;
  additionalProperties?: boolean | { type: "string"; minLength?: number };
  properties?: Record<string, FsmParamsPropertySchema>;
  required?: string[];
};

export type FsmParamsSchema = {
  type: "object";
  "x-ui"?: "route-to";
  title?: string;
  description?: string;
  "x-llmDescription"?: string;
  details?: string;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, FsmParamsPropertySchema>;
  "x-emitsRouteEvents"?: string[];
};

export const EMPTY_PARAMS_SCHEMA: FsmParamsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {},
};

export const LOOSE_PARAMS_SCHEMA: FsmParamsSchema = {
  type: "object",
  additionalProperties: true,
  properties: {},
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
