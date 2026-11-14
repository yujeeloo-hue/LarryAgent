/** Split text into lines; empty string → no lines. */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/\r?\n/);
}
