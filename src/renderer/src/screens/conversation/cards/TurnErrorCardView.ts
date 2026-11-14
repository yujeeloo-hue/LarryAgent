import { CircleAlert, RotateCcw, Settings2 } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";

/**
 * Turn error card — tool-card family chrome with danger tint.
 * Replaces the old raw red text box (`conversation-msg-system` red body):
 * a compact `.content-card` with a per-source title and a Retry pill that
 * continues the failed turn (a hidden continuation prompt — see
 * turnContinuations.ts — not a resend of the original prompt), so the
 * conversation picks up where it broke instead of redoing the task.
 */

/**
 * What a Retry click submits. Transcript-backed error rows produce the
 * continuation shape (`continuation: "retry"`) — main drops the error row
 * and starts a turn whose user message is the hidden "continue the task"
 * instruction. Ephemeral failures (the turn never started, so the prompt
 * was never persisted) keep the composer-ready text + attachments shape:
 * retrying those resends the prompt, otherwise the task would be lost.
 */
export type TurnErrorRetryPayload = {
  /** Persisted error message id — consumed via removeTurnError on retry. */
  errorMessageId?: string;
  /** Hidden continuation retry (transcript-backed error rows). */
  continuation?: "retry";
  /** Composer-ready prompt (ephemeral failures only). */
  text?: string;
  attachments?: Array<{
    path: string;
    name: string;
    kind: string;
    mimeType: string;
    sizeBytes?: number;
  }>;
};

/**
 * Error-row detection is shared with main (turnErrorConsume) via
 * src/session/turnErrorText.ts: whatever renders a Retry pill here must be
 * removable there, or the row (and its pill) resurfaces on re-entry.
 */
import {
  isTurnErrorTextPart,
  isTurnErrorMessage,
} from "../../../../../session/turnErrorText.js";

export { isTurnErrorTextPart, isTurnErrorMessage };

/** Card title differentiated by failure source. */
export function turnErrorTitle(text: string): string {
  if (text.startsWith("Queued message could not start a turn:")) {
    return "Queued prompt failed";
  }
  if (text.startsWith("Turn handoff failed to start:")) {
    return "Handoff failed";
  }
  return "Turn failed";
}

/**
 * Missing-key detection: matches the main-process error copy (single source
 * of truth — sessionRuntime turn start / llm:checkHealth), including the
 * variant "Add it in Setting…" / ".env" suffixes and the queued / handoff
 * wrappers that embed the raw message.
 */
export function isMissingApiKeyError(text: string): boolean {
  return text.includes("Missing API key for provider");
}

type MessageLike = {
  id?: string;
  role: string;
  parts: Array<Record<string, unknown>>;
};

/**
 * Retry payloads for every error message inside a turn group. Retry is a
 * hidden continuation: the turn's leading user message (turn[0] per
 * splitMessagesIntoTurns) must exist — its prompt stays in the transcript
 * and the model continues from it. Turns without one (handoff / queue /
 * plan-control failures) get no retry — their prompt is not a user message.
 */
export function turnErrorRetryPayloadsByMessageId(
  turn: MessageLike[],
): Map<string, TurnErrorRetryPayload> {
  const map = new Map<string, TurnErrorRetryPayload>();
  const lead = turn[0];
  if (!lead || lead.role !== "user") return map;
  for (const message of turn) {
    if (!isTurnErrorMessage(message)) continue;
    if (typeof message.id === "string" && message.id.length > 0) {
      map.set(message.id, { continuation: "retry", errorMessageId: message.id });
    }
  }
  return map;
}

/** Error body short enough to skip the scroll clamp. */
const SHORT_ERROR_MAX_CHARS = 200;

/** False = retry rejected (running turn / consume failed); the pill restores. */
export type RetryOutcome = Promise<boolean | void> | boolean | void;

export function createTurnErrorCard(input: {
  text: string;
  /** Resend payload; null hides the Retry pill (not a user-prompt turn). */
  retry?: TurnErrorRetryPayload | null;
  onRetry?: (payload: TurnErrorRetryPayload) => RetryOutcome;
}): HTMLElement {
  const card = document.createElement("div");
  card.className = "content-card content-card-error";

  const summary = document.createElement("div");
  summary.className = "content-card-tool-result-summary";

  const left = document.createElement("div");
  left.className = "content-card-tool-result-left";

  const icon = createLucideIcon(CircleAlert, { size: 15 });
  icon.classList.add("content-card-tool-icon");
  left.append(icon);

  const name = document.createElement("span");
  name.className = "content-card-tool-name";
  const title = turnErrorTitle(input.text);
  name.textContent = title;
  name.title = title;
  left.append(name);

  const right = document.createElement("div");
  right.className = "content-card-tool-result-right";

  if (input.retry && input.onRetry) {
    const retryBtn = document.createElement("button");
    retryBtn.type = "button";
    retryBtn.className = "content-card-error-retry";
    retryBtn.title = "Continue the task from where it failed";
    retryBtn.setAttribute("aria-label", "Retry turn");
    const retryIcon = createLucideIcon(RotateCcw, { size: 13 });
    retryBtn.append(retryIcon, document.createTextNode("Retry"));
    retryBtn.addEventListener("click", () => {
      if (retryBtn.disabled) return;
      retryBtn.disabled = true;
      // Consume immediately: collapse the body so the click visibly takes,
      // and block a second click while the resend is in flight. The row is
      // dropped by the transcript refresh once the resend starts.
      card.classList.add("is-consumed");
      void Promise.resolve(input.onRetry?.(input.retry!)).then((outcome) => {
        if (outcome === false) {
          card.classList.remove("is-consumed");
          retryBtn.disabled = false;
        }
      });
    });
    right.append(retryBtn);
  }

  if (isMissingApiKeyError(input.text)) {
    // Failure was "no key configured" — offer the setup wizard at the
    // point of failure. Lazy import keeps the wizard module (CSS + raw SVG
    // brand assets) out of this file's static graph: node tests import
    // this card module directly and cannot load those import forms.
    const setupBtn = document.createElement("button");
    setupBtn.type = "button";
    setupBtn.className = "content-card-error-retry content-card-error-setup";
    setupBtn.title = "Configure a provider via the setup wizard";
    setupBtn.setAttribute("aria-label", "Open setup wizard");
    setupBtn.append(
      createLucideIcon(Settings2, { size: 13 }),
      document.createTextNode("Open setup wizard"),
    );
    setupBtn.addEventListener("click", () => {
      void import("../../../ui/providerWizardStandalone.js")
        .then((wizard) =>
          wizard.runStandaloneProviderWizard({ setActiveFirst: true }),
        )
        .catch((err) => {
          console.error("[turn-error] open setup wizard failed", err);
        });
    });
    right.append(setupBtn);
  }

  summary.append(left, right);
  card.append(summary);

  const body = document.createElement("div");
  body.className = "content-card-error-body";
  const text = document.createElement("pre");
  text.className = "content-card-error-text";
  if (
    input.text.length <= SHORT_ERROR_MAX_CHARS &&
    !input.text.includes("\n")
  ) {
    text.classList.add("is-short");
  }
  text.textContent = input.text.trim();
  body.append(text);
  card.append(body);

  return card;
}
