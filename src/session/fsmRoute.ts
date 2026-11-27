export function parseFsmRouteArgs(args: {
  route?: unknown;
  reason?: unknown;
}):
  | { ok: true; route: string; reason: string }
  | { ok: false; message: string } {
  const route = typeof args.route === "string" ? args.route.trim() : "";
  if (!route) {
    return {
      ok: false,
      message: 'Invalid arguments: "route" is required.',
    };
  }
  const reason =
    typeof args.reason === "string" && args.reason.trim()
      ? args.reason.trim()
      : `route to ${route}`;
  return { ok: true, route, reason };
}
