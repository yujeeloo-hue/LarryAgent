import type { FsmParamsSchema } from "../paramsSchema.js";

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
