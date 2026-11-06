/**
 * Configurable tool allow / deny lists for FSM PrepareTools / RunTools.
 * Patterns support exact names or simple globs (`*` → any substring).
 */

export function asToolNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && x.length > 0);
}

/** Exact match, or glob where `*` matches any substring (case-insensitive). */
export function matchesToolNamePattern(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) return name === pattern;
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

export function matchesAnyToolNamePattern(
  name: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((p) => matchesToolNamePattern(name, p));
}

/**
 * Default-allow when both lists are empty.
 * Deny wins; when allow is non-empty, the name must match allow (after deny).
 */
export function isToolNamePermitted(
  name: string,
  options: {
    allowTools?: readonly string[];
    denyTools?: readonly string[];
  },
): boolean {
  const deny = options.denyTools ?? [];
  const allow = options.allowTools ?? [];
  if (deny.length > 0 && matchesAnyToolNamePattern(name, deny)) return false;
  if (allow.length > 0) return matchesAnyToolNamePattern(name, allow);
  return true;
}

/** Compose an optional role predicate with allow/deny lists. */
export function composeToolPredicate(
  base: ((name: string) => boolean) | undefined,
  options: {
    allowTools?: readonly string[];
    denyTools?: readonly string[];
  },
): ((name: string) => boolean) | undefined {
  const allow = options.allowTools ?? [];
  const deny = options.denyTools ?? [];
  if (allow.length === 0 && deny.length === 0) return base;
  return (name: string) => {
    if (base && !base(name)) return false;
    return isToolNamePermitted(name, { allowTools: allow, denyTools: deny });
  };
}
