import type { SubagentRole } from "./types.js";

/** Ephemeral role hint after [SUBAGENT] in Bucket0. */
export function buildSubagentSystemPrompt(role: SubagentRole): string {
  const roleLine =
    role === "explore"
      ? "Role: explore (read-only)."
      : role === "worker"
        ? "Role: worker."
        : "Role: general.";

  return ["[Subagent]", roleLine, "Finish with the required JSON object only."].join(
    "\n",
  );
}
