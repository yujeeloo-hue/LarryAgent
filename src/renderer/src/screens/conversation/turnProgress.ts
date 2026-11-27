type MessagePartLike = Record<string, unknown> & { type?: string };

type MessageLike = {
  role: string;
  parts: MessagePartLike[];
};

export function shouldShowTurnProgress(input: {
  progressText: string;
  messages: MessageLike[];
  sessionStatus: SessionStatus;
  isLocallyStreaming: boolean;
  overrideActive?: boolean;
  toolCardOwnsProgress?: boolean;
}): boolean {
  const trimmed = input.progressText.trim();
  if (!trimmed) return false;

  if (input.sessionStatus === "error") return false;
  if (input.sessionStatus !== "running" && input.overrideActive !== true) {
    return false;
  }

  if (input.isLocallyStreaming) return false;

  if (input.toolCardOwnsProgress) return false;

  return true;
}

export function isAnimatedProgressText(progressText: string): boolean {
  const normalized = progressText.trim().toLowerCase().replace(/…/g, "...");
  if (!normalized) return false;
  return (
    normalized.startsWith("thinking") ||
    normalized.startsWith("reasoning") ||
    normalized.startsWith("planning") ||
    normalized.startsWith("gathering") ||
    normalized.startsWith("reviewing") ||
    normalized.startsWith("replanning") ||
    normalized.startsWith("running") ||
    normalized.startsWith("executing") ||
    normalized.startsWith("writing") ||
    normalized.startsWith("editing") ||
    normalized.startsWith("reading") ||
    normalized.startsWith("searching") ||
    normalized.startsWith("listing") ||
    normalized.startsWith("waiting") ||
    normalized.startsWith("retrying") ||
    normalized.startsWith("compacting") ||
    normalized.startsWith("dispatching") ||
    normalized.startsWith("awaiting") ||
    normalized.startsWith("installing") ||
    normalized.startsWith("creating") ||
    normalized.startsWith("updating") ||
    normalized.startsWith("deleting") ||
    normalized.startsWith("loading") ||
    normalized.startsWith("converting") ||
    normalized.startsWith("describing") ||
    normalized.startsWith("uploading") ||
    normalized.startsWith("displaying")
  );
}
