
export function asToolNameList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && x.length > 0);
}

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
