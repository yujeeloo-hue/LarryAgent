import { icon } from "./icons.js";
import { resolveToolHint } from "./toolDisplay.js";
import { finishReasoningToolChips, resumeReasoningToolChips, setReasoningToolChips } from "./reasoningToolChips.js";
import { setReasoningTitle } from "./reasoningTitle.js";

export type ReasoningBlockMode = "streaming" | "collapsed" | "expanded";

export type ReasoningBlockStats = {
  durationMs?: number;
  tokenCount?: number;
};

export type ReasoningToolRecord = {
  id: string;
  hint: string;
  durationMs?: number;
  failed?: boolean;
};

export function requestRaf(fn: () => void): number {
  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => number };
  if (typeof g.requestAnimationFrame === "function") return g.requestAnimationFrame(fn);
  return setTimeout(fn, 16) as unknown as number;
}

export function cancelRaf(handle: number): void {
  const g = globalThis as { cancelAnimationFrame?: (h: number) => void };
  if (typeof g.cancelAnimationFrame === "function") g.cancelAnimationFrame(handle);
  else clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

export function formatReasoningDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

export function formatToolRecordDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return formatReasoningDuration(ms);
}

export function formatTokenCount(tokens: number): string {
  const n = Math.max(0, tokens);
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatReasoningMeta(stats: ReasoningBlockStats): string {
  const parts: string[] = [];
  if (typeof stats.durationMs === "number" && Number.isFinite(stats.durationMs)) {
    parts.push(formatReasoningDuration(stats.durationMs));
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
  const titleEl = toggle.querySelector<HTMLElement>(".conversation-reasoning-title");
  const metaEl = toggle.querySelector<HTMLElement>(".conversation-reasoning-meta");
  if (!titleEl || !metaEl) return;
  const status = mode === "streaming" ? root.dataset.statusText?.trim() : "";
  setReasoningTitle(titleEl, status || (mode === "streaming" ? "Thinking…" : "Thought"));
  const meta = formatReasoningMeta(stats);
  metaEl.textContent = meta ? ` · ${meta}` : "";
  metaEl.hidden = !meta;
}

const TOKEN_CHASE_FACTOR = 0.18;
const TOKEN_CHASE_EPSILON = 0.5;

type TokenChase = {
  rafId: number | null;
  target: ReasoningBlockStats;
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

function hasExpandableBody(root: HTMLElement): boolean {
  if (root.dataset.contentPending === "1") return true;
  const body = root.querySelector<HTMLElement>(".conversation-reasoning-body");
  if (!body) return false;
  if (root.dataset.mode === "streaming") {
    const cot = body.querySelector<HTMLElement>(".conversation-reasoning-cot");
    return Boolean(cot?.textContent?.trim());
  }
  return Boolean(body.textContent?.trim());
}

function syncReasoningEmptyState(root: HTMLElement): void {
  const empty = !hasExpandableBody(root);
  root.classList.toggle("is-empty", empty);
  if (empty && root.classList.contains("is-open")) {
    root.classList.remove("is-open");
    root
      .querySelector<HTMLElement>(".conversation-reasoning-toggle")
      ?.setAttribute("aria-expanded", "false");
      }
      }

      export function markReasoningBlockContent(root: HTMLElement): void {
      root.dataset.contentPending = "1";
      syncReasoningEmptyState(root);
      }

function renderReasoningMeta(root: HTMLElement, stats: ReasoningBlockStats): void {
  const toggle = root.querySelector<HTMLElement>(".conversation-reasoning-toggle");
  if (!toggle) return;
  const mode = modeOf(root);
  setToggleLabel(root, toggle, mode === "streaming" ? "streaming" : "collapsed", stats);
}

function tickTokenChase(root: HTMLElement): void {
  const chase = tokenChaseFor(root);
  chase.rafId = null;
  if (!root.isConnected) return;
  const target = chase.target.tokenCount;
  if (!validTokenCount(target)) return;
  const diff = target - chase.displayedTokens;
  if (Math.abs(diff) <= TOKEN_CHASE_EPSILON) {
    chase.displayedTokens = target;
    renderReasoningMeta(root, { ...chase.target, tokenCount: target });
    return;
  }
  chase.displayedTokens += diff * TOKEN_CHASE_FACTOR;
  renderReasoningMeta(root, { ...chase.target, tokenCount: chase.displayedTokens });
  chase.rafId = requestRaf(() => {
    chase.rafId = null;
    tickTokenChase(root);
  });
}

function setOpenState(root: HTMLElement, toggle: HTMLElement, open: boolean): void {
  if (open && root.classList.contains("is-empty")) return;
  root.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  if (root.dataset.mode !== "streaming") {
    root.dataset.mode = open ? "expanded" : "collapsed";
  }
}

function iconEl(name: string, cls: string, size = 12): HTMLElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = icon(name, size);
  const svg = tpl.content.firstElementChild as SVGElement | null;
  if (!svg) return document.createElement("span");
  svg.classList.add(cls);
  return svg as unknown as HTMLElement;
}

export function createReasoningBlock(input: {
  text: string;
  mode: ReasoningBlockMode;
  stats?: ReasoningBlockStats;
  startOpen?: boolean;
  toolHints?: readonly string[];
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

  const spinner = iconEl("loaderCircle", "conversation-reasoning-spinner");
  const lightbulb = iconEl("lightbulb", "conversation-reasoning-lightbulb");
  const chevron = iconEl("chevronRight", "conversation-reasoning-chevron");
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
  if (text) delete root.dataset.contentPending;
  cot.textContent = text;
  syncReasoningEmptyState(root);
}

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

export function reasoningBlockToolHints(root: HTMLElement): string[] {
  try {
    const parsed: unknown = JSON.parse(root.dataset.toolHints ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
}

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

  const iconElWrap = document.createElement("span");
  iconElWrap.className = "conversation-reasoning-toollog-icon";
  iconElWrap.append(iconEl(resolved.icon, "conversation-reasoning-toollog-icon-glyph", 12));
  const name = document.createElement("span");
  name.className = "conversation-reasoning-toollog-name";
  name.textContent = resolved.label || record.hint;
  row.append(iconElWrap, name);
  if (hasDetail || record.count > 1) {
    const cell = document.createElement("span");
    cell.className = "conversation-reasoning-toollog-detail-cell";
    if (hasDetail) {
      const detail = document.createElement("span");
      detail.className = "conversation-reasoning-toollog-detail";
      detail.textContent = resolved.text;
      cell.append(detail);
    }
    if (record.count > 1) {
      const x = document.createElement("span");
      x.className = "conversation-reasoning-toollog-x";
      x.textContent = `×${record.count}`;
      cell.append(x);
    }
    row.append(cell);
  }
  if (record.durationMs !== null) {
    const dur = document.createElement("span");
    dur.className = "conversation-reasoning-toollog-dur";
    dur.textContent = formatToolRecordDuration(record.durationMs);
    row.append(dur);
  }
  return row;
}

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

export function setReasoningBlockToolRecords(
  root: HTMLElement,
  records: readonly ReasoningToolRecord[],
): void {
  root.dataset.toolRecords = JSON.stringify(records);
  renderReasoningToollog(root);
}

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
  const resolved = resolveToolHint(hint);
  const chip = document.createElement("span");
  chip.className = "conversation-reasoning-chip";
  chip.dataset.hint = hint;
  chip.title = hint;
  const glyph = document.createElement("span");
  glyph.className = "conversation-reasoning-chip-glyph";
  glyph.append(iconEl(resolved.icon, "conversation-reasoning-chip-icon", 12));
  const text = document.createElement("span");
  text.className = "conversation-reasoning-chip-text";
  text.textContent = resolved.text;
  chip.append(glyph, text);
  return chip;
}

export function setReasoningBlockToolHints(root: HTMLElement, hints: readonly string[]): void {
  root.dataset.toolHints = JSON.stringify(hints);
  setReasoningToolChips(root, hints, buildToolChip);
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
    if (chase.rafId != null) {
      cancelRaf(chase.rafId);
      chase.rafId = null;
    }
    chase.displayedTokens = 0;
    renderReasoningMeta(root, stats);
    return;
  }
  if (chase.rafId != null) return;
  chase.rafId = requestRaf(() => {
    chase.rafId = null;
    tickTokenChase(root);
  });
}

export function finalizeReasoningBlock(
  root: HTMLElement,
  stats?: ReasoningBlockStats,
): void {
  root.dataset.mode = "collapsed";
  delete root.dataset.statusText;
  root.classList.remove("status-shimmer");
  syncReasoningEmptyState(root);
  finishReasoningToolChips(root);
  renderReasoningToollog(root);
  const toggle = root.querySelector<HTMLElement>(".conversation-reasoning-toggle");
  if (toggle) {
    setOpenState(root, toggle, false);
    setReasoningBlockStats(root, stats ?? {});
  } else {
    root.classList.remove("is-open");
  }
}

export function resumeReasoningBlockStreaming(root: HTMLElement, stats?: ReasoningBlockStats): void {
  root.dataset.mode = "streaming";
  root.dataset.streaming = "1";
  resumeReasoningToolChips(root);
  const log = root.querySelector<HTMLElement>(".conversation-reasoning-toollog");
  if (log) log.hidden = true;
  syncReasoningEmptyState(root);
  if (stats) setReasoningBlockStats(root, stats);
}

export function estimateReasoningTokensFromText(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
