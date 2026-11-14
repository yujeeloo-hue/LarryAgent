/**
 * Returns true when matcher is empty or the candidate matches the JS regex.
 * Invalid matcher patterns never match (fail soft for listing; callers may
 * treat as skip).
 */
export function matchesHookMatcher(
  matcher: string | undefined,
  candidate: string,
): boolean {
  const raw = matcher?.trim();
  if (!raw) return true;
  try {
    return new RegExp(raw).test(candidate);
  } catch {
    return false;
  }
}

/**
 * Matcher candidate for a tool-related event.
 * Shell events prefer the command string when present.
 */
export function matcherCandidateForToolEvent(input: {
  event: string;
  toolName: string;
  shellCommand?: string;
  mcpServerId?: string;
}): string {
  if (
    (input.event === "beforeShellExecution" ||
      input.event === "afterShellExecution") &&
    typeof input.shellCommand === "string"
  ) {
    return input.shellCommand;
  }
  if (
    (input.event === "beforeMCPExecution" ||
      input.event === "afterMCPExecution") &&
    typeof input.mcpServerId === "string" &&
    input.mcpServerId
  ) {
    return input.mcpServerId;
  }
  return input.toolName;
}
