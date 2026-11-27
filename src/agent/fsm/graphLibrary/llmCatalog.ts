import type {
  FsmParamsPropertySchema,
  FsmParamsSchema,
} from "../paramsSchema.js";


export type LlmDescribableSchema = {
  description?: string;
  "x-llmDescription"?: string;
};

export function llmDescriptionOf(
  schema: LlmDescribableSchema | undefined,
): string | undefined {
  if (!schema) return undefined;
  const llm = schema["x-llmDescription"]?.trim();
  if (llm) return llm;
  const human = schema.description?.trim();
  return human ? human : undefined;
}

function propertyOut(
  prop: FsmParamsPropertySchema,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (prop.type) out.type = prop.type;
  if (prop.enum) out.enum = prop.enum;
  if (prop.default !== undefined) out.default = prop.default;
  if (prop.minimum !== undefined) out.minimum = prop.minimum;
  if (prop.minLength !== undefined) out.minLength = prop.minLength;
  if (prop["x-showWhen"]) out["x-appliesWhen"] = prop["x-showWhen"];
  if (prop["x-ui"] === "pin-select" || prop["x-ui"] === "pin-map" || prop["x-ui"]?.endsWith("pin-bindings") || prop["x-ui"] === "route-bindings") out["x-reference"] = "local-node-pins";
  const description = llmDescriptionOf(prop);
  if (description) out.description = description;
  if (prop.type === "array" && prop.items) {
    const items: Record<string, unknown> = {};
    if (prop.items.type) items.type = prop.items.type;
    if (prop.items.minLength !== undefined) {
      items.minLength = prop.items.minLength;
    }
    if (prop.items.properties) {
      items.properties = propertiesOut(prop.items.properties);
    }
    if (prop.items.required) items.required = prop.items.required;
    if (prop.items.additionalProperties !== undefined) {
      items.additionalProperties = prop.items.additionalProperties;
    }
    out.items = items;
  }
  if (prop.type === "object") {
    if (prop.properties) out.properties = propertiesOut(prop.properties);
    if (prop.required) out.required = prop.required;
    if (prop.additionalProperties !== undefined) {
      out.additionalProperties = prop.additionalProperties;
    }
  }
  return out;
}

function propertiesOut(
  properties: Record<string, FsmParamsPropertySchema>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [key, prop] of Object.entries(properties)) {
    out[key] = propertyOut(prop);
  }
  return out;
}

export function toLlmParamsSchema(
  schema: FsmParamsSchema,
): Record<string, unknown> {
  const out: Record<string, unknown> = { type: "object" };
  const description = llmDescriptionOf(schema);
  if (description) out.description = description;
  if (schema.details?.trim()) out.details = schema.details;
  if (schema.additionalProperties !== undefined) {
    out.additionalProperties = schema.additionalProperties;
  }
  if (schema.required) out.required = schema.required;
  if (schema.properties) out.properties = propertiesOut(schema.properties);
  if (schema["x-emitsRouteEvents"]?.length) {
    out["x-emitsRouteEvents"] = schema["x-emitsRouteEvents"];
  }
  return out;
}
