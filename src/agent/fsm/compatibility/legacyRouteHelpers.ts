/** Fixed route conversion helpers for historical graph inputs. */
type RouteBinding = {event: string; to: string};

export function normalizeRouteBindings(raw: unknown): RouteBinding[] {
  if (Array.isArray(raw)) {
    const rows: RouteBinding[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const event =
        typeof (item as { event?: unknown }).event === "string"
          ? (item as { event: string }).event.trim()
          : "";
      const to =
        typeof (item as { to?: unknown }).to === "string"
          ? (item as { to: string }).to.trim()
          : typeof (item as { pin?: unknown }).pin === "string"
            ? (item as { pin: string }).pin.trim()
            : "";
      if (!event || !to) continue;
      rows.push({ event, to });
    }
    return rows;
  }
  if (raw && typeof raw === "object") {
    const rows: RouteBinding[] = [];
    for (const [event, to] of Object.entries(raw as Record<string, unknown>)) {
      const e = event.trim();
      if (!e || typeof to !== "string" || !to.trim()) continue;
      rows.push({ event: e, to: to.trim() });
    }
    return rows;
  }
  return [];
}

export function legacyWhenRowToExpr(row: Record<string, unknown>): string {
  if (typeof row.expr === "string" && row.expr.trim()) {
    return row.expr.trim();
  }
  if (Array.isArray(row.allOf)) {
    const parts = row.allOf
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim())
      .filter(Boolean);
    if (parts.length > 0) return parts.join(" && ");
  }
  if (typeof row.key === "string" && row.key.trim()) {
    const raw = row.key.trim();
    if (raw.includes(",")) {
      return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .join(" && ");
    }
    return raw;
  }
  return "";
}
