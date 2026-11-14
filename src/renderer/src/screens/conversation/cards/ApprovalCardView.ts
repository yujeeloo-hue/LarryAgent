import { Ban, Check, ChevronDown, ShieldAlert, Timer } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";

export type ApprovalCardRisk = {
  /** True when the finding was fatal (asks even under Bypass). */
  fatal: boolean;
  /** Assessor's human-facing risk sentence (first line of the reason block). */
  reason: string;
  /** True when approving executes the recoverable Trash-routed variant. */
  trashRewrite: boolean;
};

export type ApprovalCardInput = {
  requestId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  /** Epoch ms when the auto-deny timer fires. */
  expiresAt: number;
  /** Shell Safe Mode risk context — absent for plain level-2 asks. */
  risk?: ApprovalCardRisk;
  onAllow: () => void;
  onDeny: () => void;
};

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return "No arguments";
  return entries
    .slice(0, 4)
    .map(([key, value]) => {
      const raw =
        typeof value === "string" ? value : JSON.stringify(value) ?? "null";
      const clipped = raw.length > 48 ? `${raw.slice(0, 45)}…` : raw;
      return `${key}: ${clipped}`;
    })
    .join("\n");
}

function secondsLeft(expiresAt: number): number {
  return Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
}

/**
 * Single countdown ticker shared by every live approval card. The Deny fill
 * animation and this label both derive from the same expiresAt — the label
 * exists so the deadline stays readable under prefers-reduced-motion.
 * One interval per module; idles as a no-op when no card is mounted.
 */
let countdownTicker: ReturnType<typeof setInterval> | null = null;

function ensureCountdownTicker(): void {
  if (countdownTicker !== null) return;
  countdownTicker = setInterval(() => {
    const nodes = document.querySelectorAll<HTMLElement>(
      ".content-card-approval-countdown",
    );
    if (nodes.length === 0) return;
    for (const node of nodes) {
      const expiresAt = Number(node.dataset.expiresAt ?? 0);
      const label = node.querySelector<HTMLElement>(
        ".content-card-approval-countdown-label",
      );
      if (label) label.textContent = `Auto-deny in ${secondsLeft(expiresAt)}s`;
    }
  }, 500);
  // Node (DOM tests) would otherwise stay alive on this forever-running
  // interval; browsers have no unref and simply ignore it.
  (countdownTicker as unknown as { unref?: () => void }).unref?.();
}

export function createApprovalCard(input: ApprovalCardInput): HTMLElement {
  const card = document.createElement("div");
  card.className = "content-card content-card-approval";
  card.dataset.requestId = input.requestId;
  card.dataset.tone = input.risk
    ? input.risk.fatal
      ? "fatal"
      : "high"
    : "plain";

  // --- Header: shield tile + title/tool lines + risk chip, all one axis ---
  const header = document.createElement("div");
  header.className = "content-card-approval-header";

  const icon = document.createElement("div");
  icon.className = "content-card-approval-icon";
  icon.append(createLucideIcon(ShieldAlert, { size: 16 }));

  const headtext = document.createElement("div");
  headtext.className = "content-card-approval-headtext";
  const title = document.createElement("div");
  title.className = "content-card-approval-title";
  title.textContent = "Permission required";
  const tool = document.createElement("div");
  tool.className = "content-card-approval-tool";
  tool.textContent = input.toolName;
  headtext.append(title, tool);

  header.append(icon, headtext);
  if (input.risk) {
    const chip = document.createElement("span");
    chip.className = "content-card-approval-chip";
    chip.textContent = input.risk.fatal ? "Fatal" : "High risk";
    header.append(chip);
  }

  // --- Reason block: block-flow paragraph lines (never horizontal flex —
  //     that shatters inline wrapping across the two sentences). ---
  let reasonEl: HTMLElement | null = null;
  if (input.risk) {
    const reason = document.createElement("div");
    reason.className = "content-card-approval-reason";
    const riskLine = document.createElement("p");
    riskLine.className = "content-card-approval-reason-risk";
    riskLine.textContent = input.risk.reason;
    reason.append(riskLine);
    if (input.risk.trashRewrite) {
      const rewriteLine = document.createElement("p");
      rewriteLine.className = "content-card-approval-reason-rewrite";
      rewriteLine.textContent =
        "Allowing runs the recoverable variant instead — targets move to the Trash.";
      reason.append(rewriteLine);
    }
    reasonEl = reason;
  }

  // --- Body: shell commands get a prompt-prefixed Command block; other
  //     level-2 tools keep the summarized argument lines. ---
  const command =
    typeof input.arguments.command === "string"
      ? input.arguments.command
      : null;
  const body = document.createElement("div");
  body.className = "content-card-approval-body";
  const bodyLabel = document.createElement("div");
  bodyLabel.className = "content-card-approval-body-label";
  bodyLabel.textContent = command === null ? "Arguments" : "Command";
  const bodyPre = document.createElement("pre");
  if (command !== null) {
    const prompt = document.createElement("span");
    prompt.className = "content-card-approval-prompt";
    prompt.textContent = "$  ";
    bodyPre.append(prompt, document.createTextNode(command));
  } else {
    bodyPre.textContent = summarizeArgs(input.arguments);
  }
  body.append(bodyLabel, bodyPre);

  const details = document.createElement("details");
  details.className = "content-card-approval-details";
  const detailsSummary = document.createElement("summary");
  detailsSummary.append(
    createLucideIcon(ChevronDown, { size: 14 }),
    document.createTextNode("Full arguments"),
  );
  const pre = document.createElement("pre");
  pre.className = "content-card-tool-json";
  pre.textContent = JSON.stringify(input.arguments, null, 2);
  details.append(detailsSummary, pre);

  // --- Footer: textual countdown (single source: expiresAt) + actions ---
  const foot = document.createElement("div");
  foot.className = "content-card-approval-foot";

  const countdown = document.createElement("span");
  countdown.className = "content-card-approval-countdown";
  countdown.dataset.expiresAt = String(input.expiresAt);
  countdown.append(createLucideIcon(Timer, { size: 12 }));
  const countdownLabel = document.createElement("span");
  countdownLabel.className = "content-card-approval-countdown-label";
  countdownLabel.textContent = `Auto-deny in ${secondsLeft(input.expiresAt)}s`;
  countdown.append(countdownLabel);
  ensureCountdownTicker();

  const actions = document.createElement("div");
  actions.className = "content-card-approval-actions";

  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "content-card-approval-deny";
  // Countdown fill: timeout auto-denies, so the deny background fills up as
  // the deadline approaches — full fill means the deny is about to fire.
  const denyFill = document.createElement("span");
  denyFill.className = "content-card-approval-deny-fill";
  denyFill.style.setProperty(
    "animation-duration",
    `${Math.max(0, input.expiresAt - Date.now())}ms`,
  );
  const denyLabel = document.createElement("span");
  denyLabel.className = "content-card-approval-deny-label";
  denyLabel.append(
    createLucideIcon(Ban, { size: 13 }),
    document.createTextNode("Deny"),
  );
  deny.append(denyFill, denyLabel);
  deny.addEventListener("click", () => input.onDeny());

  const allow = document.createElement("button");
  allow.type = "button";
  allow.className = "content-card-approval-allow action-primary";
  allow.append(
    createLucideIcon(Check, { size: 13 }),
    document.createTextNode("Allow"),
  );
  allow.addEventListener("click", () => input.onAllow());

  actions.append(deny, allow);
  foot.append(countdown, actions);
  card.append(...(reasonEl ? [header, reasonEl] : [header]), body, details, foot);
  return card;
}
