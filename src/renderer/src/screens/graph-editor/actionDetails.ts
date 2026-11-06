/** Action catalog schema → editor help plumbing (details / paragraphs). */

/** Long-form details from an action catalog entry's paramsSchema. */
export function schemaDetails(
  schema: Record<string, unknown> | undefined,
): string | null {
  const details = schema?.details;
  return typeof details === "string" && details.trim()
    ? details.trim()
    : null;
}

/** Split a details text into paragraphs on blank lines. */
export function detailParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}
