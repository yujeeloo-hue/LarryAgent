import type { JsonObject, JsonValue } from "../session/types.js";

export type ParseToolArgumentsResult =
  | { ok: true; value: JsonObject }
  | { ok: false; error: string; value: JsonObject };

export type ValidateToolArgumentsResult =
  | { ok: true }
  | { ok: false; error: string };

/**
 * Parse tool `argumentsRaw` into an object.
 * Empty / whitespace-only raw is treated as `{}` (tools with no args).
 * Invalid JSON or non-object values fail explicitly (do not silently become {}).
 */
export function parseToolArgumentsRaw(raw: string): ParseToolArgumentsResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: {} };
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      error: "Invalid arguments: tool arguments must be valid JSON.",
      value: {},
    };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      ok: false,
      error: "Invalid arguments: tool arguments must be a JSON object.",
      value: {},
    };
  }

  return { ok: true, value: value as JsonObject };
}

/**
 * Lightweight JSON-Schema subset check against a tool's `parameters`.
 * Covers: object root, required, type (incl. unions / null), enum, anyOf /
 * oneOf, array items / minItems, nested object properties, and
 * additionalProperties: false.
 */
export function validateToolArguments(
  args: JsonObject,
  parameters: JsonObject,
): ValidateToolArgumentsResult {
  return validateValue(args, parameters, "");
}

function validateValue(
  value: JsonValue | undefined,
  schema: JsonObject,
  path: string,
): ValidateToolArgumentsResult {
  if (value === undefined) {
    return {
      ok: false,
      error: path
        ? `Invalid arguments: missing required property "${path}".`
        : "Invalid arguments: missing value.",
    };
  }

  const union =
    Array.isArray(schema.anyOf) && schema.anyOf.length > 0
      ? schema.anyOf
      : Array.isArray(schema.oneOf) && schema.oneOf.length > 0
        ? schema.oneOf
        : null;
  if (union) {
    const typeMatched: ValidateToolArgumentsResult[] = [];
    for (const variant of union) {
      const variantSchema = asObject(variant);
      if (!variantSchema) continue;
      const result = validateValue(value, variantSchema, path);
      if (result.ok) return result;
      if (variantSchema.type === undefined || typeMatches(value, variantSchema.type)) {
        typeMatched.push(result);
      }
    }
    // A single variant of the value's own type explains the failure precisely.
    if (typeMatched.length === 1) return typeMatched[0]!;
    return {
      ok: false,
      error: `Invalid arguments: "${path || "value"}" does not match any allowed schema.`,
    };
  }

  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    return {
      ok: false,
      error: path
        ? `Invalid arguments: "${path}" expected ${formatExpectedType(schema.type)}, got ${valueKind(value)}.`
        : `Invalid arguments: expected ${formatExpectedType(schema.type)}, got ${valueKind(value)}.`,
    };
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    if (!schema.enum.some((item) => Object.is(item, value))) {
      return {
        ok: false,
        error: `Invalid arguments: "${path || "value"}" must be one of ${formatEnum(schema.enum)}.`,
      };
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return {
        ok: false,
        error: `Invalid arguments: "${path || "value"}" must have at least ${schema.minItems} item(s).`,
      };
    }
    const itemsSchema = asObject(schema.items);
    if (itemsSchema) {
      for (let i = 0; i < value.length; i += 1) {
        const itemPath = path ? `${path}[${i}]` : `[${i}]`;
        const itemResult = validateValue(value[i], itemsSchema, itemPath);
        if (!itemResult.ok) return itemResult;
      }
    }
  }

  if (isPlainObject(value)) {
    const nestedProps = asObject(schema.properties);
    const nestedRequired = asStringArray(schema.required);
    for (const key of nestedRequired) {
      const missing =
        !Object.prototype.hasOwnProperty.call(value, key) ||
        value[key] === undefined;
      if (!missing) continue;
      // Strict schemas list nullable optionals in `required`; models often omit
      // them instead of sending null. Treat missing+nullable as null (ok).
      const propSchema = nestedProps ? asObject(nestedProps[key]) : null;
      if (propSchema && schemaAllowsNull(propSchema)) {
        continue;
      }
      const keyPath = path ? `${path}.${key}` : key;
      return {
        ok: false,
        error: `Invalid arguments: missing required property "${keyPath}".`,
      };
    }

    if (nestedProps) {
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(nestedProps, key)) {
            const keyPath = path ? `${path}.${key}` : key;
            return {
              ok: false,
              error: `Invalid arguments: unexpected property "${keyPath}".`,
            };
          }
        }
      }
      for (const [key, rawSchema] of Object.entries(nestedProps)) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        const propSchema = asObject(rawSchema);
        if (!propSchema) continue;
        const keyPath = path ? `${path}.${key}` : key;
        const result = validateValue(value[key], propSchema, keyPath);
        if (!result.ok) return result;
      }
    } else if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        const keyPath = path ? `${path}.${key}` : key;
        return {
          ok: false,
          error: `Invalid arguments: unexpected property "${keyPath}".`,
        };
      }
    }
  }

  return { ok: true };
}

function schemaAllowsNull(schema: JsonObject): boolean {
  if (schema.type === "null") return true;
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  const union =
    Array.isArray(schema.anyOf) && schema.anyOf.length > 0
      ? schema.anyOf
      : Array.isArray(schema.oneOf) && schema.oneOf.length > 0
        ? schema.oneOf
        : null;
  if (union) {
    return union.some((variant) => {
      const v = asObject(variant);
      return v !== null && schemaAllowsNull(v);
    });
  }
  return false;
}

function typeMatches(value: JsonValue, schemaType: JsonValue): boolean {
  const allowed = normalizeTypeList(schemaType);
  if (allowed.length === 0) return true;
  const kind = valueKind(value);
  return allowed.some((t) => {
    if (t === "integer") {
      return kind === "number" && Number.isInteger(value);
    }
    return t === kind;
  });
}

function normalizeTypeList(schemaType: JsonValue): string[] {
  if (typeof schemaType === "string") return [schemaType];
  if (Array.isArray(schemaType)) {
    return schemaType.filter((t): t is string => typeof t === "string");
  }
  return [];
}

function formatExpectedType(schemaType: JsonValue): string {
  const list = normalizeTypeList(schemaType);
  if (list.length === 0) return "a value";
  if (list.length === 1) return list[0]!;
  return list.join(" | ");
}

function formatEnum(values: JsonValue[]): string {
  return values.map((v) => JSON.stringify(v)).join(", ");
}

function valueKind(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function asObject(value: JsonValue | undefined): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value;
}

function asStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isPlainObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
