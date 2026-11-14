/** Build a jellybot-file URL the renderer can use in <img> / <iframe src>. */
export function localFileMediaUrl(absolutePath: string): string {
  const trimmed = absolutePath.trim();
  if (!trimmed) return "";
  return `jellybot-file://local/?path=${encodeURIComponent(trimmed)}`;
}
