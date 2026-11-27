import type {
  HookEventName,
  HookListEntry,
  InProcessHookRegistration,
} from "./types.js";

const registrations: InProcessHookRegistration[] = [];

export type RegisterHookOptions = {
  id?: string;
  matcher?: string;
  failClosed?: boolean;
};

export function listInProcessHooks(
  event?: HookEventName,
): InProcessHookRegistration[] {
  if (!event) return [...registrations];
  return registrations.filter((r) => r.event === event);
}

export function inProcessHooksAsListEntries(): HookListEntry[] {
  return registrations.map((r) => ({
    id: r.id,
    event: r.event,
    source: "in-process" as const,
    command: "in-process",
    ...(r.matcher ? { matcher: r.matcher } : {}),
    failClosed: r.failClosed === true,
  }));
}
