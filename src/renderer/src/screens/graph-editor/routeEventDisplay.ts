type RouteGuideRow = { routeTo?: unknown };

/** Event names an Action may emit (schema + live routeGuide rows). */
export function collectActionEmittedRouteEvents(
  schema: Record<string, unknown> | undefined,
  params: Record<string, unknown>,
): string[] {
  const events = new Set<string>();
  const declared = schema?.["x-emitsRouteEvents"];
  if (Array.isArray(declared)) {
    for (const raw of declared) {
      if (typeof raw === "string" && raw.trim()) {
        events.add(raw.trim());
      }
    }
  }
  const guide = params.routeGuide;
  if (Array.isArray(guide)) {
    for (const row of guide) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const routeTo = (row as RouteGuideRow).routeTo;
      if (typeof routeTo === "string" && routeTo.trim()) {
        events.add(routeTo.trim());
      }
    }
  }
  return [...events].sort((a, b) => a.localeCompare(b));
}
