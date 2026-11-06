/**
 * Ambient mirror of the desktop `src/renderer/src/env.d.ts` SessionStatus
 * union — shared logic files imported from the main app (turnProgress.ts)
 * reference it without an import, so the console build needs the same
 * ambient name in scope.
 */
type SessionStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "error"
  | "cancelled";
