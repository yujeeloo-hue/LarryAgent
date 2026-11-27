import type { UnrealBlueprintSymbol } from "../../../shared/unrealBlueprintReferences.js";

const HEADING = /^#{1,6}\s+([a-z-]+)\s+`?([A-Za-z_]\w*)`?/m;
const CONTAINER = /^\/\/ In ([A-Za-z_][\w:]*)\s*$/m;
const METHOD_KINDS = new Set(["instance-method", "static-method", "method"]);

function containerClass(markdown: string): string | null {
  const scope = CONTAINER.exec(markdown)?.[1];
  if (!scope) return null;
  const last = scope.split("::").pop() ?? "";
  return /^[A-Za-z_]\w*$/.test(last) ? last : null;
}

export function blueprintSymbolFromHover(markdown: string | null): UnrealBlueprintSymbol | null {
  if (!markdown) return null;
  const heading = HEADING.exec(markdown);
  if (!heading) return null;
  const kind = heading[1]!;
  const name = heading[2]!;
  if (kind === "class") return { kind: "class", className: name };
  if (kind === "constructor") return { kind: "class", className: containerClass(markdown) ?? name };
  if (METHOD_KINDS.has(kind)) {
    const owner = containerClass(markdown);
    return owner ? { kind: "function", className: owner, name } : null;
  }
  return null;
}
