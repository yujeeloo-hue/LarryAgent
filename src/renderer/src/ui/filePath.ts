/** Convert file:// URI or absolute path to a filesystem path. */
export function fileUriToPath(uriOrPath: string): string {
  const raw = uriOrPath.trim();
  if (!raw) return "";
  if (raw.startsWith("file:")) {
    try {
      const url = new URL(raw);
      let path = decodeURIComponent(url.pathname);
      // Windows file URLs: /C:/... → C:/...
      if (/^\/[A-Za-z]:\//.test(path)) {
        path = path.slice(1);
      }
      return path;
    } catch {
      return raw.replace(/^file:\/\//, "");
    }
  }
  return raw;
}
