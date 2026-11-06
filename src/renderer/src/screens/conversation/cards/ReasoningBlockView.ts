/**
 * Collapsible Thought / Thinking block for provider CoT.
 * Presentation-only — not sent back to the model.
 */

import { ChevronRight, Lightbulb, LoaderCircle } from "lucide";
import { formatTokenCount } from "../../../ui/contextUsage.js";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { resolveToolHint } from "./toolDisplay.js";
import { formatToolRecordDuration, formatTurnDuration } from "../turnDuration.js";
import type { ReasoningToolRecord } from "../turnDisplay.js";
import { finishReasoningToolChips, resumeReasoningToolChips, setReasoningToolChips } from "../../../ui/reasoningToolChips.js";
import { setReasoningTitle } from "../../../ui/reasoningTitle.js";

export type ReasoningBlockMode = "streaming" | "collapsed" | "expanded";

export type ReasoningBlockStats = {
  durationMs?: number;
  tokenCount?: number;
};

function formatReasoningMeta(stats: ReasoningBlockStats): string {
  const parts: string[] = [];
  if (typeof stats.durationMs === "number" && Number.isFinite(stats.durationMs)) {
    parts.push(formatTurnDuration(stats.durationMs));
  }
  if (
    typeof stats.tokenCount === "number" &&
    Number.isFinite(stats.tokenCount) &&
    stats.tokenCount > 0
  ) {
    parts.push(`${formatTokenCount(stats.tokenCount)} tokens`);
  }
  return parts.join(" · ");
}

function setToggleLabel(
  root: HTMLElement,
  toggle: HTMLElement,
  mode: ReasoningBlockMode,
  stats: ReasoningBlockStats,
): void {
  const titleEl = toggle.querySelector<HTMLElement>(
    ".conversation-reasoning-title",
  );
  const metaEl = toggle.querySelector<HTMLElement>(
    ".conversation-reasoning-meta",
  );
  if (!titleEl || !metaEl) return;
  // Status row: while streaming with no CoT yet, the title carries the live
  // turn progress text (the old composer-right status row content) instead
  // of a fixed "Thinking…" label.
  const status = mode === "streaming" ? root.dataset.statusText?.trim() : "";
  setReasoningTitle(titleEl, status || (mode === "streaming" ? "Thinking…" : "Thought"));
  const meta = formatReasoningMeta(stats);
  metaEl.textContent = meta ? ` · ${meta}` : "";
  metaEl.hidden = !meta;
}

/**
 * Token count "chase" animation.
 *
 * Live reasoning stats arrive in discrete jumps (text paints, a 250 ms meta
 * ticker), which made the token counter snap between values. Instead we keep
 * the last displayed count and ease it toward the latest target on a RAF loop:
 * each frame closes ~18% of the remaining gap, so the number counts up (or
 * down, when a final provider count lands below the live estimate) smoothly
 * and settles exactly on the target once it is within half a token.
 */

/** Fraction of the remaining gap closed per animation frame. */
const TOKEN_CHASE_FACTOR = 0.18;
/** Stop chasing once the eased count is this close to the target. */
const TOKEN_CHASE_EPSILON = 0.5;

type TokenChase = {
  rafId: number | null;
  /** Latest stats pushed via setReasoningBlockStats. */
  target: ReasoningBlockStats;
  /** Last token count the user saw; also the seed for a resumed chase. */
  displayedTokens: number;
};

const tokenChases = new WeakMap<HTMLElement, TokenChase>();

function tokenChaseFor(root: HTMLElement): TokenChase {
  let chase = tokenChases.get(root);
  if (!chase) {
    chase = { rafId: null, target: {}, displayedTokens: 0 };
    tokenChases.set(root, chase);
  }
  return chase;
}

function validTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function modeOf(root: HTMLElement): ReasoningBlockMode {
  const raw = root.dataset.mode;
  return raw === "streaming" || raw === "expanded" || raw === "collapsed"
    ? raw
    : "collapsed";
}

/** True when the body carries text the user could expand into. */
function hasExpandableBody(root: HTMLElement): boolean {
  // Buffered CoT: the collapsed body paints lazily (on open), so the first
  // deltas live in the caller's buffer — the contentPending mark keeps such
  // a block expandable from the first delta.
  if (root.dataset.contentPending === "1") return true;
  const body = root.querySelector<HTMLElement>(".conversation-reasoning-body");
  if (!body) return false;
  // While streaming the tool record stays hidden (the dock owns live
  // feedback), so it must not count as body content — expanding over it
  // would show a blank body. Only painted CoT expands a live block.
  if (root.dataset.mode === "streaming") {
    const cot = body.querySelector<HTMLElement>(".conversation-reasoning-cot");
    return Boolean(cot?.textContent?.trim());
  }
  return Boolean(body.textContent?.trim());
}

/**
 * Keep expandability in sync with the body: a block with nothing inside is
 * inert for its whole life, not just after finalize — a live status-only
 * shell (no CoT yet, no tool-hint fallback) must not expand on click
 * either. Also gates cursor / hover affordances via the is-empty class.
 */
function syncReasoningEmptyState(root: HTMLElement): void {
  const empty = !hasExpandableBody(root);
  root.classList.toggle("is-empty", empty);
  // Invariant: an empty block is never left open (e.g. the hint fallback
  // body it was expanded on got cleared).
  if (empty && root.classList.contains("is-open")) {
    root.classList.remove("is-open");
    root
      .querySelector<HTMLElement>(".conversation-reasoning-toggle")
      ?.setAttribute("aria-expanded", "false");
  }
}

/**
 * Mark that this block carries (buffered) reasoning content even while its
 * collapsed body is still unpainted — called when the first CoT delta or
 * tool hint reaches the row. The lazy paint clears the mark once the body
 * carries real text.
 */
export function markReasoningBlockContent(root: HTMLElement): void {
  root.dataset.contentPending = "1";
  syncReasoningEmptyState(root);
}

/** Render the toggle label from exact stats — no easing. */
function renderReasoningMeta(
  root: HTMLElement,
  stats: ReasoningBlockStats,
): void {
  const toggle = root.querySelector<HTMLElement>(
    ".conversation-reasoning-toggle",
  );
  if (!toggle) return;
  const mode = modeOf(root);
  setToggleLabel(root, toggle, mode === "streaming" ? "streaming" : "collapsed", stats);
}

function tickTokenChase(root: HTMLElement): void {
  const chase = tokenChaseFor(root);
  chase.rafId = null;
  if (!root.isConnected) return; // block left the DOM — drop the chase
  const target = chase.target.tokenCount;
  if (!validTokenCount(target)) return;
  const diff = target - chase.displayedTokens;
  if (Math.abs(diff) <= TOKEN_CHASE_EPSILON) {
    // Settled: snap to the exact target so the final label is precise
    // (formatting can differ by one digit near rounding boundaries).
    chase.displayedTokens = target;
    renderReasoningMeta(root, { ...chase.target, tokenCount: target });
    return;
  }
  chase.displayedTokens += diff * TOKEN_CHASE_FACTOR;
  renderReasoningMeta(root, {
    ...chase.target,
    tokenCount: chase.displayedTokens,
  });
  chase.rafId = requestAnimationFrame(() => {
    chase.rafId = null;
    tickTokenChase(root);
  });
}

function setOpenState(root: HTMLElement, toggle: HTMLElement, open: boolean): void {
  if (open && root.classList.contains("is-empty")) return; // no body — nothing to expand
  root.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  // While streaming, keep mode=streaming so labels/meta stay on Thinking.
  if (root.dataset.mode !== "streaming") {
    root.dataset.mode = open ? "expanded" : "collapsed";
  }
}

export function createReasoningBlock(input: {
  text: string;
  mode: ReasoningBlockMode;
  stats?: ReasoningBlockStats;
  /** When mode is streaming, start expanded (default: collapsed). */
  startOpen?: boolean;
  /** Tools that ran without a card; shown in the title's icon dock. */
  toolHints?: readonly string[];
  /** Per-call records for the expanded body's tool list (V1). */
  toolRecords?: readonly ReasoningToolRecord[];
}): HTMLElement {
  const root = document.createElement("div");
  root.className = "conversation-reasoning";
  root.dataset.mode = input.mode;

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "conversation-reasoning-toggle";

  const leading = document.createElement("span");
  leading.className = "conversation-reasoning-leading";
  leading.setAttribute("aria-hidden", "true");

  const spinner = createLucideIcon(LoaderCircle, { size: 12 });
  spinner.classList.add("conversation-reasoning-spinner");

  const lightbulb = createLucideIcon(Lightbulb, { size: 12 });
  lightbulb.classList.add("conversation-reasoning-lightbulb");

  const chevron = createLucideIcon(ChevronRight, { size: 12 });
  chevron.classList.add("conversation-reasoning-chevron");

  leading.append(spinner, lightbulb, chevron);

  const titleEl = document.createElement("span");
  titleEl.className = "conversation-reasoning-title";

  const metaEl = document.createElement("span");
  metaEl.className = "conversation-reasoning-meta";

  const toolsEl = document.createElement("span");
  toolsEl.className = "conversation-reasoning-tools";
  toolsEl.hidden = true;
  const sepEl = document.createElement("span");
  sepEl.className = "conversation-reasoning-tools-sep";
  sepEl.textContent = "·";
  const chipsEl = document.createElement("span");
  chipsEl.className = "conversation-reasoning-chips";
  const chipsCountEl = document.createElement("span");
  chipsCountEl.className = "conversation-reasoning-chips-count";
  chipsCountEl.hidden = true;
  toolsEl.append(sepEl, chipsEl, chipsCountEl);

  toggle.append(leading, titleEl, metaEl, toolsEl);
  setToggleLabel(root, toggle, input.mode, input.stats ?? {});

  const bodyOuter = document.createElement("div");
  bodyOuter.className = "conversation-reasoning-body-outer";

  const body = document.createElement("div");
  body.className = "conversation-reasoning-body";
  // CoT lives in its own child so the tool record can share the body without
  // textContent paints wiping it.
  const cot = document.createElement("div");
  cot.className = "conversation-reasoning-cot";
  cot.textContent = input.text;
  body.append(cot);
  bodyOuter.append(body);

  const open =
    input.mode === "expanded" ||
    (input.mode === "streaming" && input.startOpen === true);

  toggle.addEventListener("click", () => {
    setOpenState(root, toggle, !root.classList.contains("is-open"));
  });

  root.append(toggle, bodyOuter);
  // Expandability sync runs only AFTER the body is attached — an earlier
  // call sees no .conversation-reasoning-body descendant and stamps every
  // block is-empty (pure-CoT blocks never recovered → not expandable).
  syncReasoningEmptyState(root);
  setOpenState(root, toggle, open);
  if (input.toolRecords && input.toolRecords.length > 0) {
    setReasoningBlockToolRecords(root, input.toolRecords);
  } else if (input.toolHints && input.toolHints.length > 0) {
    setReasoningBlockToolHints(root, input.toolHints);
  }
  return root;
}

export function setReasoningBlockText(root: HTMLElement, text: string): void {
  const cot = root.querySelector<HTMLElement>(".conversation-reasoning-cot");
  if (!cot) return;
  if (text) delete root.dataset.contentPending; // painted — the body is real now
  cot.textContent = text;
  syncReasoningEmptyState(root);
}

/**
 * Live status line on the streaming block's title — the old composer-right
 * status row, relocated onto the Thinking block itself. Empty text clears it
 * (title returns to "Thinking…"); callers only set it while the block has no
 * streaming CoT yet, so "Thinking…" shows exactly while reasoning streams.
 */
export function setReasoningBlockStatusText(
  root: HTMLElement,
  text: string,
  options?: { animated?: boolean },
): void {
  const trimmed = text.trim();
  if (trimmed) root.dataset.statusText = trimmed;
  else delete root.dataset.statusText;
  root.classList.toggle(
    "status-shimmer",
    options?.animated === true && Boolean(trimmed),
  );
  const toggle = root.querySelector<HTMLElement>(
    ".conversation-reasoning-toggle",
  );
  if (toggle) {
    setToggleLabel(root, toggle, modeOf(root), tokenChases.get(root)?.target ?? {});
  }
}

/** Hidden-tool hints currently on this block's title (oldest first). */
export function reasoningBlockToolHints(root: HTMLElement): string[] {
  try {
    const parsed: unknown = JSON.parse(root.dataset.toolHints ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

/** Records stored on this block (oldest first); [] when none were pushed. */
export function reasoningBlockToolRecords(root: HTMLElement): ReasoningToolRecord[] {
  try {
    const parsed: unknown = JSON.parse(root.dataset.toolRecords ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const records: ReasoningToolRecord[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.hint !== "string" || !record.hint) continue;
      records.push({
        id: typeof record.id === "string" ? record.id : record.hint,
        hint: record.hint,
        ...(typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
          ? { durationMs: record.durationMs }
          : {}),
        ...(record.failed === true ? { failed: true } : {}),
      });
    }
    return records;
  } catch {
    return [];
  }
}

/** One merged run of the same tool + object (render-side ×N). */
type MergedToolRecord = {
  hint: string;
  count: number;
  durationMs: number | null;
  failed: boolean;
};

function mergeToolRecords(records: readonly ReasoningToolRecord[]): MergedToolRecord[] {
  const merged: MergedToolRecord[] = [];
  for (const record of records) {
    const last = merged[merged.length - 1];
    if (last && last.hint === record.hint) {
      last.count += 1;
      if (typeof record.durationMs === "number") {
        last.durationMs = (last.durationMs ?? 0) + record.durationMs;
      }
      last.failed = last.failed || record.failed === true;
      continue;
    }
    merged.push({
      hint: record.hint,
      count: 1,
      durationMs: typeof record.durationMs === "number" ? record.durationMs : null,
      failed: record.failed === true,
    });
  }
  return merged;
}

function buildToolRecordRow(record: MergedToolRecord): HTMLElement {
  const resolved = resolveToolHint(record.hint);
  const row = document.createElement("li");
  row.className = "conversation-reasoning-toollog-row";
  if (record.failed) row.classList.add("is-failed");
  const hasDetail = resolved.label !== "" && resolved.text !== record.hint;
  const titleParts = [record.hint];
  if (record.count > 1) titleParts.push(`×${record.count}`);
  if (record.durationMs !== null) titleParts.push(formatToolRecordDuration(record.durationMs));
  if (record.failed) titleParts.push("failed");
  row.title = titleParts.join(" · ");

  const icon = createLucideIcon(resolved.icon, { size: 12, strokeWidth: 2 });
  icon.classList.add("conversation-reasoning-toollog-icon");
  const name = document.createElement("span");
  name.className = "conversation-reasoning-toollog-name";
  name.textContent = resolved.label || record.hint;
  row.append(icon, name);
  if (hasDetail) {
    const cell = document.createElement("span");
    cell.className = "conversation-reasoning-toollog-detail-cell";
    const detail = document.createElement("span");
    detail.className = "conversation-reasoning-toollog-detail";
    detail.textContent = resolved.text;
    cell.append(detail);
    if (record.count > 1) {
      const x = document.createElement("span");
      x.className = "conversation-reasoning-toollog-x";
      x.textContent = `×${record.count}`;
      cell.append(x);
    }
    row.append(cell);
  } else if (record.count > 1) {
    const x = document.createElement("span");
    x.className = "conversation-reasoning-toollog-x";
    x.textContent = `×${record.count}`;
    row.append(x);
  }
  if (record.durationMs !== null) {
    const dur = document.createElement("span");
    dur.className = "conversation-reasoning-toollog-dur";
    dur.textContent = formatToolRecordDuration(record.durationMs);
    row.append(dur);
  }
  return row;
}

/**
 * Paint the expanded body's tool record (V1 list). Records come from the
 * projection (per-call duration/status) or fall back to the title hints
 * (older sessions). Hidden while streaming — the record is a Thought
 * artifact; the live dock owns in-progress feedback.
 */
function renderReasoningToollog(root: HTMLElement): void {
  const body = root.querySelector<HTMLElement>(".conversation-reasoning-body");
  if (!body) return;
  let log = body.querySelector<HTMLElement>(".conversation-reasoning-toollog");
  const records = reasoningBlockToolRecords(root);
  const fallback = records.length === 0 ? reasoningBlockToolHints(root) : [];
  const effective = records.length > 0
    ? records
    : fallback.map((hint) => ({ id: hint, hint }));
  if (effective.length === 0) {
    log?.remove();
    syncReasoningEmptyState(root);
    return;
  }
  if (!log) {
    log = document.createElement("div");
    log.className = "conversation-reasoning-toollog";
    body.append(log);
  }
  log.replaceChildren();
  const head = document.createElement("div");
  head.className = "conversation-reasoning-toollog-head";
  const label = document.createElement("span");
  label.className = "conversation-reasoning-toollog-head-label";
  label.textContent = "Tools";
  const count = document.createElement("span");
  count.className = "conversation-reasoning-toollog-count";
  count.textContent = `· ${effective.length} ${effective.length === 1 ? "call" : "calls"}`;
  head.append(label, count);
  const rows = document.createElement("ol");
  rows.className = "conversation-reasoning-toollog-rows";
  for (const merged of mergeToolRecords(effective)) rows.append(buildToolRecordRow(merged));
  log.append(head, rows);
  log.hidden = root.dataset.mode === "streaming";
  syncReasoningEmptyState(root);
}

/** Replace the record list (projection paints whole segments at once). */
export function setReasoningBlockToolRecords(
  root: HTMLElement,
  records: readonly ReasoningToolRecord[],
): void {
  root.dataset.toolRecords = JSON.stringify(records);
  renderReasoningToollog(root);
}

/** Upsert one call's record (live: stamped at tool_call, updated at finish). */
export function upsertReasoningToolRecord(
  root: HTMLElement,
  record: ReasoningToolRecord,
): void {
  const records = reasoningBlockToolRecords(root);
  const index = records.findIndex((item) => item.id === record.id);
  if (index >= 0) records[index] = record;
  else records.push(record);
  setReasoningBlockToolRecords(root, records);
}

function buildToolChip(hint: string): HTMLElement {
  const { icon, text } = resolveToolHint(hint);
  const chip = document.createElement("span");
  chip.className = "conversation-reasoning-chip";
  chip.dataset.hint = hint;
  chip.title = hint;
  const iconEl = createLucideIcon(icon, { size: 12, strokeWidth: 2 });
  iconEl.classList.add("conversation-reasoning-chip-icon");
  const glyph = document.createElement("span");
  glyph.className = "conversation-reasoning-chip-glyph";
  glyph.append(iconEl);
  const textEl = document.createElement("span");
  textEl.className = "conversation-reasoning-chip-text";
  textEl.textContent = text;
  chip.append(glyph, textEl);
  return chip;
}

/** Ordinary tools stay in the live dock; the expandable record survives finalization. */
export function setReasoningBlockToolHints(root: HTMLElement, hints: readonly string[]): void {
  root.dataset.toolHints = JSON.stringify(hints);
  setReasoningToolChips(root, hints, buildToolChip);
  // No CoT yet and no records (old sessions): the structured record falls
  // back to these hints, so the body must reflect them immediately.
  if (reasoningBlockToolRecords(root).length === 0) renderReasoningToollog(root);
  else syncReasoningEmptyState(root);
}

export function setReasoningBlockStats(
  root: HTMLElement,
  stats: ReasoningBlockStats,
): void {
  const chase = tokenChaseFor(root);
  chase.target = stats;
  if (!validTokenCount(stats.tokenCount)) {
    // No token target: render exactly what we were given (no chase), and
    // stop any animation that was still running toward a previous target.
    if (chase.rafId != null) {
      cancelAnimationFrame(chase.rafId);
      chase.rafId = null;
    }
    chase.displayedTokens = 0;
    renderReasoningMeta(root, stats);
    return;
  }
  if (chase.rafId != null) return; // already chasing — tick picks up the new target
  chase.rafId = requestAnimationFrame(() => {
    chase.rafId = null;
    tickTokenChase(root);
  });
}

export function finalizeReasoningBlock(
  root: HTMLElement,
  stats?: ReasoningBlockStats,
): void {
  root.dataset.mode = "collapsed";
  // Drop any live status line — the Thought title must never keep the
  // shimmer / progress text (some callers finalize with no live reasoning
  // id, skipping the status-clearing paths above them).
  delete root.dataset.statusText;
  root.classList.remove("status-shimmer");
  // A Thought with no body is not expandable — nothing to show on click.
  syncReasoningEmptyState(root);
  finishReasoningToolChips(root);
  // Thought finalized: the tool record becomes visible in the body (it
  // stayed hidden through streaming — the dock owned live feedback).
  renderReasoningToollog(root);
  const toggle = root.querySelector<HTMLElement>(
    ".conversation-reasoning-toggle",
  );
  if (toggle) {
    setOpenState(root, toggle, false);
    // Chase to the final count too, so the estimate eases onto the last value.
    setReasoningBlockStats(root, stats ?? {});
  } else {
    root.classList.remove("is-open");
  }
}

/** Re-enter live Thinking (spinner) after a premature collapse / remount.
 * Idempotent: if already streaming, leave the spinner node and CSS animation alone
 * (rewriting data-mode restarts the spin and looks like a stutter).
 */
export function resumeReasoningBlockStreaming(
  root: HTMLElement,
  stats?: ReasoningBlockStats,
): void {
  if (root.dataset.mode === "streaming") {
    if (stats) setReasoningBlockStats(root, stats);
    return;
  }
  root.dataset.mode = "streaming";
  root.dataset.streaming = "1";
  resumeReasoningToolChips(root);
  // Back live: the record hides again (it re-shows at the next finalize).
  const log = root.querySelector<HTMLElement>(".conversation-reasoning-toollog");
  if (log) log.hidden = true;
  // The record no longer counts while hidden — re-evaluate so a record-only
  // block does not stay expandable over a blank body.
  syncReasoningEmptyState(root);
  const toggle = root.querySelector<HTMLElement>(
    ".conversation-reasoning-toggle",
  );
  if (toggle) {
    setReasoningBlockStats(root, stats ?? {});
  }
}

/** Cheap live estimate (≈ o200k density) without loading BPE on every paint. */
export function estimateReasoningTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
