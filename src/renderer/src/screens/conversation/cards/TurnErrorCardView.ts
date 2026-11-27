import { CircleAlert, RotateCcw, Settings2 } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";


export type TurnErrorRetryPayload = {
  errorMessageId?: string;
  continuation?: "retry";
  text?: string;
  attachments?: Array<{
    path: string;
    name: string;
    kind: string;
    mimeType: string;
    sizeBytes?: number;
  }>;
};

import {
  isTurnErrorTextPart,
  isTurnErrorMessage,
} from "../../../../../session/turnErrorText.js";

export { isTurnErrorTextPart, isTurnErrorMessage };

export function turnErrorTitle(text: string): string {
  if (text.startsWith("Queued message could not start a turn:")) {
    return "Queued prompt failed";
  }
  return "Turn failed";
}

export function isMissingApiKeyError(text: string): boolean {
  return text.includes("Missing API key for provider");
}

type MessageLike = {
  id?: string;
  role: string;
  parts: Array<Record<string, unknown>>;
};

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

const SHORT_ERROR_MAX_CHARS = 200;

export type RetryOutcome = Promise<boolean | void> | boolean | void;

export function createTurnErrorCard(input: {
  text: string;
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
