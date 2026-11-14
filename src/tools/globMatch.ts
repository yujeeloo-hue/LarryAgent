/**
 * Minimal glob → RegExp compiler shared by the `glob` tool and grep's `glob`
 * filter. Matches POSIX-style paths relative to the search root.
 *
 * Supported: `*`, `?`, `**`, `[...]` / `[!...]`, `{a,b}` (nestable).
 * A pattern without `/` matches at any depth (`*.ts` ≡ `**\/*.ts`); a
 * trailing `/` matches everything below that directory.
 */

const REGEX_SPECIAL = new Set([..."\\^$.|+()[]{}*?/"]);

function escapeChar(ch: string): string {
  return REGEX_SPECIAL.has(ch) ? `\\${ch}` : ch;
}

function translate(pattern: string): string {
  let out = "";
  let braceDepth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        const next = pattern[i + 2];
        if (atSegmentStart && next === "/") {
          out += "(?:.*/)?";
          i += 2;
          continue;
        }
        if (atSegmentStart && next === undefined) {
          out += ".*";
          i += 1;
          continue;
        }
        out += "[^/]*";
        i += 1;
        continue;
      }
      out += "[^/]*";
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
        continue;
      }
      let body = pattern.slice(i + 1, close);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      out += `[${body.replace(/\\/g, "\\\\")}]`;
      i = close;
      continue;
    }
    if (ch === "{") {
      braceDepth++;
      out += "(?:";
      continue;
    }
    if (ch === "}" && braceDepth > 0) {
      braceDepth--;
      out += ")";
      continue;
    }
    if (ch === "," && braceDepth > 0) {
      out += "|";
      continue;
    }
    out += escapeChar(ch);
  }
  while (braceDepth-- > 0) out += ")";
  return out;
}

/** Default glob case folding follows the usual filesystem behaviour. */
export function defaultGlobCaseInsensitive(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "win32" || platform === "darwin";
}

export type GlobMatcher = (relativePosixPath: string) => boolean;

export function compileGlob(
  rawPattern: string,
  options?: { caseInsensitive?: boolean },
): GlobMatcher {
  let pattern = rawPattern.trim().replace(/\\/g, "/");
  while (pattern.startsWith("./")) pattern = pattern.slice(2);
  pattern = pattern.replace(/^\/+/, "");
  if (pattern.endsWith("/")) pattern += "**";
  if (!pattern.includes("/")) pattern = `**/${pattern}`;
  const caseInsensitive =
    options?.caseInsensitive ?? defaultGlobCaseInsensitive();
  const regex = new RegExp(`^${translate(pattern)}$`, caseInsensitive ? "i" : "");
  return (path) => regex.test(path);
}
