/**
 * Sticky review chrome when planDoc.approvalPending.
 * Presentation only — Approve / Discard wired by the conversation controller.
 *
 * Compact: title + summary + Detail | Discard | Approve
 * Expanded: markdown preview inside the same panel; Detail collapses back.
 */

import { ChevronDown, ChevronUp, FileText } from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import {
  animateFold,
  playClassEnter,
  settleFold,
  waitForTransition,
} from "../foldAnimation.js";
import { renderMarkdownText } from "../renderMarkdownText.js";

export type PlanReviewBarOptions = {
  summary?: string;
  docPath?: string;
  busy?: boolean;
  error?: string | null;
  /** Restore expanded preview after a rebuild. */
  expanded?: boolean;
  /** Cached markdown body when already loaded. */
  markdown?: string | null;
  onApprove: () => void;
  onDiscard: () => void;
  /**
   * Load plan doc markdown for inline preview.
   * Return null/empty on failure (error text may be shown via setError).
   */
  onLoadMarkdown?: () => Promise<string | null>;
  /** Fired when expand/collapse changes (so the host can persist state). */
  onExpandedChange?: (expanded: boolean) => void;
  /** Fired when markdown was loaded successfully (host may cache it). */
  onMarkdownLoaded?: (markdown: string) => void;
};

export type PlanReviewBarApi = {
  root: HTMLElement;
  setExpanded: (expanded: boolean) => void;
  isExpanded: () => boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  /** Collapse (if expanded) then run action — used by Approve / Discard. */
  collapseThen: (action: () => void) => void;
  /** Slide up + fade in from below (first mount only). */
  playEnter: () => void;
  /** Slide down + fade out; resolves when the host may unmount the panel. */
  playExit: () => Promise<void>;
};

export function createPlanReviewBar(
  options: PlanReviewBarOptions,
): PlanReviewBarApi {
  const bar = document.createElement("div");
  bar.className = "plan-review-bar";
  bar.dataset.approvalPending = "true";

  const header = document.createElement("div");
  header.className = "plan-review-bar-header";

  const main = document.createElement("div");
  main.className = "plan-review-bar-main";

  const icon = createLucideIcon(FileText, { size: 16 });
  icon.classList.add("plan-review-bar-icon");

  const title = document.createElement("div");
  title.className = "plan-review-bar-title";
  title.textContent = "Plan ready for review";

  // Collapsed-only hint; folds away while the doc preview opens. The leading
  // gap lives on the inner node so max-height: 0 can clip it completely.
  const summaryEl = document.createElement("div");
  summaryEl.className = "plan-review-bar-detail";
  const summaryTextEl = document.createElement("div");
  summaryTextEl.className = "plan-review-bar-detail-text";
  const summaryText = options.summary?.trim();
  summaryTextEl.textContent =
    summaryText || "Review the plan document, then Approve or Discard.";
  summaryEl.append(summaryTextEl);

  // Icon + title stay one fixed-height row so the title is centered against the
  // icon in both states; the summary folds below it, indented to the title.
  main.append(icon, title);
  header.append(main, summaryEl);

  const actions = document.createElement("div");
  actions.className = "plan-review-bar-actions";

  const detailBtn = document.createElement("button");
  detailBtn.type = "button";
  detailBtn.className = "plan-review-bar-btn plan-review-bar-btn-secondary";
  detailBtn.hidden = !options.docPath;

  const discardBtn = document.createElement("button");
  discardBtn.type = "button";
  discardBtn.className = "plan-review-bar-btn plan-review-bar-btn-secondary action-danger";
  discardBtn.textContent = "Discard";
  discardBtn.disabled = Boolean(options.busy);

  const approveBtn = document.createElement("button");
  approveBtn.type = "button";
  approveBtn.className = "plan-review-bar-btn plan-review-bar-btn-primary action-primary";
  approveBtn.textContent = "Approve";
  approveBtn.disabled = Boolean(options.busy);

  if (options.docPath) {
    actions.append(detailBtn);
  }
  actions.append(discardBtn, approveBtn);

  // Animation wrapper (max-height) + inner scroll region (own cap).
  const preview = document.createElement("div");
  preview.className = "plan-review-bar-preview";

  const previewInner = document.createElement("div");
  previewInner.className = "plan-review-bar-preview-inner";

  const previewBody = document.createElement("div");
  previewBody.className = "plan-review-bar-preview-body content-card-markdown";
  previewInner.append(previewBody);
  preview.append(previewInner);

  const errorEl = document.createElement("div");
  errorEl.className = "plan-review-bar-error";
  errorEl.hidden = true;

  // Actions sit after the preview so expanding pushes the doc in above them
  // instead of lifting the buttons to the top of the panel.
  bar.append(header, preview, actions, errorEl);

  let expanded = false;
  let markdownCache: string | null =
    typeof options.markdown === "string" ? options.markdown : null;
  let loadInFlight: Promise<void> | null = null;

  function setError(error: string | null): void {
    const text = error?.trim() ?? "";
    if (!text) {
      errorEl.hidden = true;
      errorEl.textContent = "";
      return;
    }
    errorEl.hidden = false;
    errorEl.textContent = text;
  }

  function syncDetailButton(): void {
    detailBtn.replaceChildren();
    const chevron = createLucideIcon(expanded ? ChevronDown : ChevronUp, {
      size: 14,
    });
    const label = document.createElement("span");
    label.textContent = "Detail";
    detailBtn.append(chevron, label);
    detailBtn.setAttribute(
      "aria-expanded",
      expanded ? "true" : "false",
    );
    detailBtn.title = expanded ? "Collapse plan document" : "Expand plan document";
  }

  function renderPreview(markdown: string): void {
    previewBody.replaceChildren();
    try {
      renderMarkdownText(markdown, previewBody, { streaming: false });
    } catch {
      previewBody.textContent = markdown;
    }
  }

  function setExpanded(next: boolean): Promise<void> {
    if (expanded === next) {
      syncDetailButton();
      return Promise.resolve();
    }
    expanded = next;
    bar.classList.toggle("is-expanded", expanded);
    syncDetailButton();
    options.onExpandedChange?.(expanded);
    return Promise.all([
      animateFold(preview, expanded),
      animateFold(summaryEl, !expanded),
    ]).then(() => undefined);
  }

  async function expandAndLoad(): Promise<void> {
    // Render content before measuring so the open animation targets the
    // final height instead of the "Loading…" placeholder height.
    if (markdownCache) {
      renderPreview(markdownCache);
      await setExpanded(true);
      return;
    }
    if (!options.onLoadMarkdown) {
      previewBody.textContent = "No plan document path.";
      await setExpanded(true);
      return;
    }
    previewBody.textContent = "Loading…";
    await setExpanded(true);
    if (loadInFlight) {
      await loadInFlight;
      return;
    }
    loadInFlight = (async () => {
      try {
        const md = await options.onLoadMarkdown?.();
        if (typeof md === "string" && md.length > 0) {
          markdownCache = md;
          options.onMarkdownLoaded?.(md);
          if (expanded) renderPreview(md);
        } else if (expanded) {
          previewBody.textContent = "Could not load plan document.";
        }
      } catch (err) {
        if (expanded) {
          previewBody.textContent =
            err instanceof Error ? err.message : String(err);
        }
      } finally {
        loadInFlight = null;
      }
    })();
    await loadInFlight;
  }

  function collapseThen(action: () => void): void {
    if (expanded) {
      // Let the collapse finish before the host closes the bar.
      void setExpanded(false).then(action);
      return;
    }
    action();
  }

  detailBtn.addEventListener("click", () => {
    if (options.busy) return;
    if (expanded) {
      void setExpanded(false);
      return;
    }
    void expandAndLoad();
  });

  discardBtn.addEventListener("click", () => {
    if (options.busy) return;
    collapseThen(() => options.onDiscard());
  });

  approveBtn.addEventListener("click", () => {
    if (options.busy) return;
    collapseThen(() => options.onApprove());
  });

  if (options.error?.trim()) {
    setError(options.error);
  }
  syncDetailButton();

  if (options.expanded && options.docPath) {
    // Rebuilds restore the open state instantly; only user clicks animate.
    expanded = true;
    bar.classList.add("is-expanded");
    settleFold(preview, true);
    settleFold(summaryEl, false);
    syncDetailButton();
    void expandAndLoad();
  }

  return {
    root: bar,
    setExpanded,
    isExpanded: () => expanded,
    setBusy: (busy: boolean) => {
      discardBtn.disabled = busy;
      approveBtn.disabled = busy;
      detailBtn.disabled = busy;
    },
    setError,
    collapseThen,
    playEnter: () => playClassEnter(bar, "is-fold-in"),
    playExit: () => {
      bar.classList.add("is-fold-out");
      return waitForTransition(bar, ["transform", "opacity"], 300);
    },
  };
}
