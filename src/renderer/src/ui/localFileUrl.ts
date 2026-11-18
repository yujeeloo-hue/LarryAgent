export function localFileMediaUrl(absolutePath: string): string {
  const trimmed = absolutePath.trim();
  if (!trimmed) return "";
  return `jellybot-file://local/?path=${encodeURIComponent(trimmed)}`;
}
