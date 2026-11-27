import { randomUUID } from "node:crypto";
import { publishComputerUseSound } from "./sound.js";
import type { UserAskAnswer, UserAskRequestInput } from "../types.js";
import type { TipKind, TipSettled, TipSpec, TipsOverlay } from "./cursorOverlay.js";
import type { InputActivity } from "./service.js";
import type { Rect } from "./types.js";

export const HANDOFF_POLL_MS = 1_500;
export const CONFIRM_DEFAULT_TIMEOUT_MS = 300_000;
export const TAKEOVER_IDLE_S = 1;
export const TAKEOVER_QUIET_MS = 1_500;
const SYNTHETIC_SLACK_S = 0.35;

export type HandoffOption = { label: string; detail?: string };

export type HandoffWatch = {
  check: (signal: AbortSignal) => Promise<boolean>;
};

export type HandoffRequest = {
  kind: TipKind;
  title: string;
  message: string;
  options?: HandoffOption[];
  primaryLabel?: string;
  secondaryLabel?: string;
  anchor?: Rect | null;
  spotlight?: boolean;
  timeoutMs?: number;
  watch?: HandoffWatch;
  allowCustom?: boolean;
  desktopPassword?: UserAskRequestInput["desktopPassword"];
  handoffQrPng?: string;
};

export type HandoffOutcome =
  | "done"
  | "auto"
  | "skipped"
  | "chosen"
  | "confirmed"
  | "declined"
  | "resumed"
  | "stopped"
  | "timeout"
  | "cancelled"
  | "unanswered";

export type HandoffVia = "screen" | "conversation" | "watch" | "timer" | "none";

export type HandoffResult = {
  outcome: HandoffOutcome;
  via: HandoffVia;
  waitedMs: number;
  shownOnScreen: boolean;
  choice?: string;
  custom?: boolean;
};

export type HandoffAsk = (input: UserAskRequestInput) => Promise<UserAskAnswer | null>;

export type HandoffDeps = {
  tips: TipsOverlay;
  ask?: HandoffAsk;
  signal?: AbortSignal;
  now?: () => number;
  pollMs?: number;
  createId?: () => string;
};

type Labels = { primary: string; secondary: string };

const DEFAULT_LABELS: Record<TipKind, Labels> = {
  action: { primary: "Done", secondary: "Skip" },
  choice: { primary: "Choose", secondary: "Skip" },
  confirm: { primary: "Confirm", secondary: "Cancel" },
  takeover: { primary: "Resume", secondary: "Stop task" },
};

export function handoffLabels(request: Pick<HandoffRequest, "kind" | "primaryLabel" | "secondaryLabel">): Labels {
  const defaults = DEFAULT_LABELS[request.kind];
  const primary = request.primaryLabel?.trim() || defaults.primary;
  let secondary = request.secondaryLabel?.trim() || defaults.secondary;
  if (secondary === primary) secondary = defaults.secondary === primary ? `Not ${primary.toLowerCase()}` : defaults.secondary;
  return { primary, secondary };
}

export function handoffTimeoutMs(request: Pick<HandoffRequest, "kind" | "timeoutMs">): number | null {
  if (request.kind === "takeover") return null;
  if (request.timeoutMs !== undefined && request.timeoutMs > 0) return request.timeoutMs;
  return request.kind === "confirm" ? CONFIRM_DEFAULT_TIMEOUT_MS : null;
}

export function buildTipSpec(request: HandoffRequest, id: string): TipSpec {
  const labels = handoffLabels(request);
  const timeoutMs = handoffTimeoutMs(request);
  return {
    id,
    kind: request.kind,
    title: request.title,
    ...(request.message ? { body: request.message } : {}),
    ...(request.kind === "choice" && request.options?.length
      ? { options: request.options.map((option) => ({ label: option.label, ...(option.detail ? { sub: option.detail } : {}) })) }
      : {}),
    primary: labels.primary,
    secondary: labels.secondary,
    ...(request.kind === "confirm" ? { danger: true } : {}),
    ...(request.watch ? { watching: true } : {}),
    ...(timeoutMs !== null ? { countdown: Math.round(timeoutMs / 1000) } : {}),
    anchor: request.anchor ?? null,
    place: request.anchor ? "anchored" : "corner",
    ...(request.spotlight === false ? { spotlight: false } : {}),
  };
}

export function buildMirrorAsk(request: HandoffRequest): UserAskRequestInput {
  const labels = handoffLabels(request);
  const options = request.kind === "choice"
    ? [...(request.options ?? []).map((option) => option.label), labels.secondary]
    : [labels.primary, labels.secondary];
  const details = request.kind === "choice"
    ? (request.options ?? []).filter((option) => option.detail).map((option) => ({ label: option.label, description: option.detail! }))
    : [];
  return {
    question: request.title,
    ...(request.message ? { detail: request.message } : {}),
    options: [...new Set(options)],
    ...(details.length ? { optionDetails: details } : {}),
    allowCustom: request.kind === "choice" && request.allowCustom === true,
    allowMultiple: false,
    keepDesktop: true,
    suppressChime: true,
    ...(request.desktopPassword ? { desktopPassword: request.desktopPassword } : {}),
    ...(request.handoffQrPng ? { handoffQrPng: request.handoffQrPng } : {}),
  };
}

function primaryOutcome(kind: TipKind): HandoffOutcome {
  switch (kind) {
    case "action":
      return "done";
    case "choice":
      return "chosen";
    case "confirm":
      return "confirmed";
    case "takeover":
      return "resumed";
  }
}

function secondaryOutcome(kind: TipKind): HandoffOutcome {
  switch (kind) {
    case "action":
    case "choice":
      return "skipped";
    case "confirm":
      return "declined";
    case "takeover":
      return "stopped";
  }
}

export function outcomeFromTip(
  request: HandoffRequest,
  action: "primary" | "secondary",
  choice?: number,
): Pick<HandoffResult, "outcome" | "choice"> {
  if (action === "secondary") return { outcome: secondaryOutcome(request.kind) };
  if (request.kind === "choice") {
    const option = choice === undefined ? undefined : request.options?.[choice];
    return option ? { outcome: "chosen", choice: option.label } : { outcome: "skipped" };
  }
  return { outcome: primaryOutcome(request.kind) };
}

export function outcomeFromAnswer(
  request: HandoffRequest,
  answer: UserAskAnswer,
): Pick<HandoffResult, "outcome" | "choice" | "custom"> {
  const labels = handoffLabels(request);
  const selected = answer.selected.trim();
  if (request.kind === "choice") {
    const option = request.options?.find((item) => item.label === selected);
    if (option && !answer.custom) return { outcome: "chosen", choice: option.label };
    if (selected === labels.secondary && !answer.custom) return { outcome: "skipped" };
    return { outcome: "chosen", choice: selected, custom: true };
  }
  if (selected === labels.secondary && !answer.custom) return { outcome: secondaryOutcome(request.kind) };
  return { outcome: primaryOutcome(request.kind) };
}

export function settledView(request: HandoffRequest, result: Pick<HandoffResult, "outcome" | "choice">): TipSettled | null {
  switch (result.outcome) {
    case "done":
    case "auto":
      return { tone: "done", title: "Continuing" };
    case "chosen":
      return { tone: "done", title: result.choice ? `Going with ${result.choice}` : "Continuing" };
    case "confirmed":
      return { tone: "done", title: "Confirmed" };
    case "resumed":
      return { tone: "done", title: "Resuming" };
    case "skipped":
      return { tone: "neutral", title: "Skipped" };
    case "declined":
      return { tone: "neutral", title: "Cancelled" };
    case "stopped":
      return { tone: "neutral", title: "Task stopped" };
    case "timeout":
      return { tone: "neutral", title: request.kind === "confirm" ? "Timed out · cancelled" : "Timed out" };
    default:
      return null;
  }
}

let quietUntil = 0;

export function noteHandoffEnded(at: number): void {
  quietUntil = Math.max(quietUntil, at + TAKEOVER_QUIET_MS);
}

export function resetHandoffStateForTests(): void {
  quietUntil = 0;
}

export function userHasPointer(activity: InputActivity, now: number, options: { overJellyBot: boolean }): boolean {
  if (activity.pointerIdleS > TAKEOVER_IDLE_S) return false;
  if (activity.syntheticAgeS !== null && activity.syntheticAgeS <= activity.pointerIdleS + SYNTHETIC_SLACK_S) return false;
  if (now - activity.pointerIdleS * 1000 < quietUntil) return false;
  return !options.overJellyBot;
}

export function runHandoff(request: HandoffRequest, deps: HandoffDeps): Promise<HandoffResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const id = (deps.createId ?? randomUUID)();
  const tips = deps.tips;
  const ask = deps.ask;
  const signal = deps.signal;
  const pollMs = deps.pollMs ?? HANDOFF_POLL_MS;
  const timeoutMs = handoffTimeoutMs(request);
  const shownOnScreen = tips.available;

  if (!shownOnScreen && !ask) {
    return Promise.resolve({ outcome: "unanswered", via: "none", waitedMs: 0, shownOnScreen: false });
  }
  if (signal?.aborted) {
    return Promise.resolve({ outcome: "cancelled", via: "none", waitedMs: 0, shownOnScreen: false });
  }

  return new Promise<HandoffResult>((resolve) => {
    let settled = false;
    let tipLive = shownOnScreen;
    let mirrorLive = Boolean(ask);
    const mirrorAbort = new AbortController();
    const watchAbort = new AbortController();
    const cleanups: Array<() => void> = [];

    const finish = (result: Pick<HandoffResult, "outcome" | "via" | "choice" | "custom">): void => {
      if (settled) return;
      settled = true;
      for (const cleanup of cleanups) cleanup();
      watchAbort.abort();
      mirrorAbort.abort();
      if (tipLive) {
        const view = result.outcome === "cancelled" ? null : settledView(request, result);
        if (view) tips.settleTip(id, view);
        else tips.hideTip(id);
      }
      if (shownOnScreen) tips.resume();
      const ended = now();
      noteHandoffEnded(ended);
      resolve({
        outcome: result.outcome,
        via: result.via,
        waitedMs: Math.max(0, ended - started),
        shownOnScreen,
        ...(result.choice !== undefined ? { choice: result.choice } : {}),
        ...(result.custom ? { custom: true } : {}),
      });
    };

    const nobodyLeft = (): void => {
      if (!tipLive && !mirrorLive) finish({ outcome: "unanswered", via: "none" });
    };

    if (signal) {
      const onAbort = (): void => finish({ outcome: "cancelled", via: "none" });
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));
    }

    if (shownOnScreen) {
      const unsubscribe = tips.onTipEvent((event) => {
        if (event.event === "tip.lost") {
          if (event.id && event.id !== id) return;
          tipLive = false;
          nobodyLeft();
          return;
        }
        if (event.id !== id) return;
        finish({ ...outcomeFromTip(request, event.action, event.choice), via: "screen" });
      });
      cleanups.push(unsubscribe);
      tips.pause();
      tips.showTip(buildTipSpec(request, id));
    }

    if (ask && !settled) {
      void ask({ ...buildMirrorAsk(request), signal: mirrorAbort.signal })
        .then((answer) => {
          if (settled) return;
          if (answer) {
            finish({ ...outcomeFromAnswer(request, answer), via: "conversation" });
            return;
          }
          mirrorLive = false;
          nobodyLeft();
        })
        .catch(() => {
          if (settled) return;
          mirrorLive = false;
          nobodyLeft();
        });
    }

    if (!settled && (tipLive || mirrorLive)) publishComputerUseSound({ kind: "handoff" });

    if (timeoutMs !== null && !settled) {
      const timer = setTimeout(() => finish({ outcome: "timeout", via: "timer" }), timeoutMs);
      cleanups.push(() => clearTimeout(timer));
    }

    const watch = request.watch;
    if (watch && !settled) {
      let pollTimer: ReturnType<typeof setTimeout> | null = null;
      let wake: (() => void) | null = null;
      cleanups.push(() => {
        if (pollTimer) clearTimeout(pollTimer);
        wake?.();
      });
      const pause = (): Promise<void> =>
        new Promise<void>((done) => {
          wake = done;
          pollTimer = setTimeout(done, pollMs);
        });
      const poll = async (): Promise<void> => {
        while (!settled) {
          await pause();
          if (settled) return;
          let satisfied = false;
          try {
            satisfied = await watch.check(watchAbort.signal);
          } catch {
            satisfied = false;
          }
          if (satisfied) {
            finish({ outcome: "auto", via: "watch" });
            return;
          }
        }
      };
      void poll();
    }
  });
}
