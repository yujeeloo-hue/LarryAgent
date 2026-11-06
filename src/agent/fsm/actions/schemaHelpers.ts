import type { FsmParamsSchema } from "../paramsSchema.js";

/** Shared empty-params schema helper with catalog title/description. */
export function titledEmptySchema(
  title: string,
  description: string,
  details?: string,
  llmDescription?: string,
): FsmParamsSchema {
  return {
    type: "object",
    title,
    description,
    ...(details ? { details } : {}),
    ...(llmDescription ? { "x-llmDescription": llmDescription } : {}),
    additionalProperties: false,
    properties: {},
  };
}
