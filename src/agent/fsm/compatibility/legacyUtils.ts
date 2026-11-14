/** Historical v1 graph compatibility; independent of current graph presets. */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** SetPhase → WriteBlackboard session phase key. */
export function writeSessionPhaseAction(
  phase: string | null,
): { type: string; params: Record<string, unknown> } {
  return {
    type: "NodeActionWriteBlackboard",
    params: {
      key: "phase",
      scope: "session",
      value: phase,
    },
  };
}

