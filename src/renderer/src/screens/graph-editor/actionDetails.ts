
export function schemaDetails(
  schema: Record<string, unknown> | undefined,
): string | null {
  const details = schema?.details;
  return typeof details === "string" && details.trim()
    ? details.trim()
    : null;
}

export function detailParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}
