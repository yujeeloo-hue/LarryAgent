
export function resolveResponsesStateful(config: { baseUrl: string; responsesStateful?: boolean | undefined }): boolean {
  if (typeof config.responsesStateful === "boolean") return config.responsesStateful;
  return false;
}
