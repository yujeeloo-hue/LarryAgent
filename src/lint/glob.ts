function escapeChar(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

export function globToRegExp(pattern: string): RegExp {
  const source = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  let out = "";
  let index = 0;
  while (index < source.length) {
    const char = source[index]!;
    if (char === "*") {
      if (source[index + 1] === "*") {
        index += 2;
        if (source[index] === "/") {
          index += 1;
          out += "(?:[^/]+/)*";
        } else {
          out += ".*";
        }
        continue;
      }
      out += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      out += "[^/]";
      index += 1;
      continue;
    }
    if (char === "{") {
      const end = source.indexOf("}", index);
      if (end > index) {
        const parts = source.slice(index + 1, end).split(",").map((part) => part.trim()).filter(Boolean);
        if (parts.length > 1) {
          out += `(?:${parts.map((part) => [...part].map(escapeChar).join("")).join("|")})`;
          index = end + 1;
          continue;
        }
      }
    }
    out += escapeChar(char);
    index += 1;
  }
  return new RegExp(`^${out}$`);
}

export function isGlobPattern(value: string): boolean {
  return /[*?{]/.test(value);
}

export function includeMatches(path: string, include: readonly string[] | undefined): boolean {
  if (!include || include.length === 0) return true;
  return include.some((pattern) => globToRegExp(pattern).test(path));
}
