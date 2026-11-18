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
