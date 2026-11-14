type MessagePartLike = Record<string, unknown> & { type?: string };

type MessageLike = {
  role: string;
  parts: MessagePartLike[];
};

/**
 * Show turn progress while the session is running, except while assistant
 * text is actively streaming into the bubble.
 *
 * Turn errors are rendered as transcript messages — not the sticky status row.
 *
 * Compacting / tool waits / approval waits must remain visible even after tool
 * cards or prior assistant text exist — otherwise long write_file / shell /
 * compact look like a frozen UI.
 */
export function shouldShowTurnProgress(input: {
  progressText: string;
  messages: MessageLike[];
  sessionStatus: SessionStatus;
  isLocallyStreaming: boolean;
  /** Force visibility for host-driven work outside a running turn (e.g. /compact on an idle session). */
  overrideActive?: boolean;
  /**
   * True while a card-painting tool owns the progress line — its card is the
   * feedback (Write/Patch stream their own preview + result card), so the
   * status row must not materialize a Thinking shell next to it. Covers
   * args streaming, execution, and approval/ask waits of card tools.
   */
  toolCardOwnsProgress?: boolean;
}): boolean {
  const trimmed = input.progressText.trim();
  if (!trimmed) return false;

  // Errors belong in the conversation stream, not the sticky status line.
  if (input.sessionStatus === "error") return false;
  if (input.sessionStatus !== "running" && input.overrideActive !== true) {
    return false;
  }

  // Live token stream already fills the assistant bubble.
  if (input.isLocallyStreaming) return false;

  // The running tool's card self-describes — no status row beside it.
  if (input.toolCardOwnsProgress) return false;

  return true;
}

/** Progress lines that should use the shimmer text animation (Cursor-like). */
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
