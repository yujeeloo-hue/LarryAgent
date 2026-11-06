import type { JsonObject, JsonValue } from "../session/types.js";
import type { JsonSchemaResponseFormat } from "./types.js";

const UNSUPPORTED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "unevaluatedItems",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "dependentRequired",
  "dependentSchemas",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
  "default",
  "const",
]);

const STRING_MAP_ENTRY_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    key: { type: "string", description: "Map key." },
    value: { type: "string", description: "Map value." },
  },
  required: ["key", "value"],
  additionalProperties: false,
};

export type StrictJsonSchemaResult =
  | { ok: true; schema: JsonObject }
  | { ok: false; error: string };

/**
 * Convert a JSON-Schema-like tool/response schema into an OpenAI Structured
 * Outputs–compatible schema (strict mode).
 *
 * - Root must be an object
 * - Every object gets additionalProperties: false
 * - Every property key is listed in required
 * - Optional properties become nullable unions
 * - String maps (`additionalProperties: { type: "string" }`) become key/value arrays
 * - Unsupported constraint keywords are stripped (runtime validation stays elsewhere)
 */
export function toStrictJsonSchema(schema: JsonObject): StrictJsonSchemaResult {
  try {
    const normalized = normalizeNode(schema, true);
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
      return { ok: false, error: "Schema must normalize to an object." };
    }
    if (normalized.type !== "object") {
      return { ok: false, error: 'Strict schema root must have type "object".' };
    }
    return { ok: true, schema: normalized };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build Chat Completions `response_format` for Structured Outputs.
 * Defaults to `strict: false` (more compatible with OpenAI-compatible gateways).
 */
export function jsonSchemaResponseFormat(
  name: string,
  schema: JsonObject,
  options?: { strict?: boolean },
): JsonSchemaResponseFormat {
  const useStrict = options?.strict === true;
  if (useStrict) {
    const strict = toStrictJsonSchema(schema);
    if (!strict.ok) {
      throw new Error(`Invalid response json_schema "${name}": ${strict.error}`);
    }
    return {
      type: "json_schema",
      json_schema: {
        name,
        strict: true,
        schema: strict.schema,
      },
    };
  }
  return {
    type: "json_schema",
    json_schema: {
      name,
      strict: false,
      schema,
    },
  };
}

/** Remove keys whose value is JSON null (recursive for plain objects). */
export function stripNullFields(value: JsonValue): JsonValue {
  if (value === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripNullFields(item));
  }
  if (typeof value !== "object") return value;
  const out: JsonObject = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === null || raw === undefined) continue;
    out[key] = stripNullFields(raw);
  }
  return out;
}

function normalizeNode(schema: JsonValue, isRoot: boolean): JsonObject {
  if (!isPlainObject(schema)) {
    throw new Error("Schema node must be an object.");
  }

  if (schema.anyOf !== undefined || schema.oneOf !== undefined) {
    throw new Error("anyOf / oneOf schemas are not supported for strict conversion.");
  }
  if (schema.$ref !== undefined) {
    throw new Error("$ref schemas are not supported for strict conversion.");
  }

  const cleaned = stripUnsupported(schema);
  const type = cleaned.type;

  if (type === "object" || (type === undefined && isPlainObject(cleaned.properties))) {
    return normalizeObject(cleaned, isRoot);
  }

  if (type === "array") {
    return normalizeArray(cleaned);
  }

  if (typeof type === "string") {
    const out: JsonObject = { type };
    if (typeof cleaned.description === "string") {
      out.description = cleaned.description;
    }
    if (Array.isArray(cleaned.enum)) {
      out.enum = cleaned.enum;
    }
    return out;
  }

  if (Array.isArray(type)) {
    const out: JsonObject = {
      type: type.filter((t): t is string => typeof t === "string"),
    };
    if (typeof cleaned.description === "string") {
      out.description = cleaned.description;
    }
    if (Array.isArray(cleaned.enum)) {
      out.enum = cleaned.enum;
    }
    return out;
  }

  // Untyped property (e.g. create_mcp_server.args) — allow string or string[].
  const out: JsonObject = {
    anyOf: [
      { type: "string" },
      { type: "array", items: { type: "string" } },
      { type: "null" },
    ],
  };
  if (typeof cleaned.description === "string") {
    out.description = cleaned.description;
  }
  // Root cannot be anyOf — only nested untyped props use this path.
  if (isRoot) {
    throw new Error('Root schema must declare type "object".');
  }
  return out;
}

function normalizeObject(schema: JsonObject, isRoot: boolean): JsonObject {
  const additional = schema.additionalProperties;

  // Free-form string map → key/value array (not valid as root).
  if (isStringMapAdditional(additional) && !hasOwnProperties(schema.properties)) {
    if (isRoot) {
      throw new Error("Root cannot be an open string map; convert failed.");
    }
    const out: JsonObject = {
      type: "array",
      items: cloneJson(STRING_MAP_ENTRY_SCHEMA),
    };
    if (typeof schema.description === "string") {
      out.description = schema.description;
    }
    return out;
  }

  if (additional === true) {
    throw new Error(
      'Open object schemas (additionalProperties: true) cannot be made strict.',
    );
  }

  if (
    additional !== undefined &&
    additional !== false &&
    !isStringMapAdditional(additional)
  ) {
    throw new Error(
      "Complex additionalProperties schemas cannot be made strict.",
    );
  }

  const propertiesIn = isPlainObject(schema.properties)
    ? schema.properties
    : {};
  const requiredIn = new Set(asStringArray(schema.required));
  const propertiesOut: JsonObject = {};
  const requiredOut: string[] = [];

  for (const [key, rawProp] of Object.entries(propertiesIn)) {
    requiredOut.push(key);
    const propSchema = isPlainObject(rawProp) ? rawProp : {};

    // Property that is itself a string map.
    if (
      (propSchema.type === "object" || propSchema.type === undefined) &&
      isStringMapAdditional(propSchema.additionalProperties) &&
      !hasOwnProperties(propSchema.properties)
    ) {
      const mapArray: JsonObject = {
        type: "array",
        items: cloneJson(STRING_MAP_ENTRY_SCHEMA),
      };
      if (typeof propSchema.description === "string") {
        mapArray.description = propSchema.description;
      }
      propertiesOut[key] = requiredIn.has(key)
        ? mapArray
        : makeNullable(mapArray);
      continue;
    }

    const normalizedProp = normalizeNode(propSchema, false);
    propertiesOut[key] = requiredIn.has(key)
      ? normalizedProp
      : makeNullable(normalizedProp);
  }

  // Open string map mixed with named properties: named props + key/value entries not supported.
  if (isStringMapAdditional(additional) && hasOwnProperties(propertiesIn)) {
    throw new Error(
      "Objects with both fixed properties and additionalProperties maps are not supported.",
    );
  }

  const out: JsonObject = {
    type: "object",
    properties: propertiesOut,
    required: requiredOut,
    additionalProperties: false,
  };
  if (typeof schema.description === "string") {
    out.description = schema.description;
  }
  return out;
}

function normalizeArray(schema: JsonObject): JsonObject {
  const out: JsonObject = { type: "array" };
  if (typeof schema.description === "string") {
    out.description = schema.description;
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      throw new Error("Tuple-style array items are not supported for strict conversion.");
    }
    out.items = normalizeNode(schema.items, false);
  } else {
    // Default items to string when unspecified (better than failing MCP tools).
    out.items = { type: "string" };
  }
  return out;
}

function makeNullable(schema: JsonObject): JsonObject {
  if (schema.type === "null") return schema;

  if (typeof schema.type === "string") {
    const { type: _type, ...rest } = schema;
    const out: JsonObject = { ...rest, type: [schema.type, "null"] };
    return out;
  }

  if (Array.isArray(schema.type)) {
    const types = schema.type.filter((t): t is string => typeof t === "string");
    if (!types.includes("null")) types.push("null");
    return { ...schema, type: types };
  }

  // anyOf / complex → wrap
  if (Array.isArray(schema.anyOf)) {
    const variants = schema.anyOf.filter(isPlainObject);
    if (!variants.some((v) => v.type === "null")) {
      return { anyOf: [...variants, { type: "null" }] };
    }
    return schema;
  }

  return {
    anyOf: [schema, { type: "null" }],
  };
}

function restoreMaps(value: JsonValue, schema: JsonValue): JsonValue {
  if (!isPlainObject(schema)) return value;

  if (
    isPlainObject(value) &&
    (schema.type === "object" || schema.type === undefined)
  ) {
    const props = isPlainObject(schema.properties) ? schema.properties : {};
    const out: JsonObject = {};
    for (const [key, raw] of Object.entries(value)) {
      const propSchema = props[key];
      if (isPlainObject(propSchema) && isStringMapSchema(propSchema)) {
        out[key] = keyValueArrayToRecord(raw);
      } else if (isPlainObject(propSchema)) {
        out[key] = restoreMaps(raw, propSchema);
      } else {
        out[key] = raw;
      }
    }
    return out;
  }

  if (Array.isArray(value) && schema.type === "array" && isPlainObject(schema.items)) {
    return value.map((item) => restoreMaps(item, schema.items as JsonObject));
  }

  return value;
}

function isStringMapSchema(schema: JsonObject): boolean {
  return (
    (schema.type === "object" || schema.type === undefined) &&
    isStringMapAdditional(schema.additionalProperties) &&
    !hasOwnProperties(schema.properties)
  );
}

function keyValueArrayToRecord(value: JsonValue): JsonValue {
  if (!Array.isArray(value)) return value;
  const out: JsonObject = {};
  for (const item of value) {
    if (!isPlainObject(item)) continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (!key || typeof item.value !== "string") continue;
    out[key] = item.value;
  }
  return out;
}

function isStringMapAdditional(additional: JsonValue | undefined): boolean {
  return (
    isPlainObject(additional) &&
    additional.type === "string" &&
    !hasOwnProperties(additional.properties)
  );
}

function stripUnsupported(schema: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function hasOwnProperties(properties: JsonValue | undefined): boolean {
  return isPlainObject(properties) && Object.keys(properties).length > 0;
}

function asStringArray(value: JsonValue | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function isPlainObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
