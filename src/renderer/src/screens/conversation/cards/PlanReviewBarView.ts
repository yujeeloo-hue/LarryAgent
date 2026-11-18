
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
  expanded?: boolean;
  markdown?: string | null;
  onApprove: () => void;
  onDiscard: () => void;
  onLoadMarkdown?: () => Promise<string | null>;
  onExpandedChange?: (expanded: boolean) => void;
  onMarkdownLoaded?: (markdown: string) => void;
};

export type PlanReviewBarApi = {
  root: HTMLElement;
  setExpanded: (expanded: boolean) => void;
  isExpanded: () => boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  collapseThen: (action: () => void) => void;
  playEnter: () => void;
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

  const summaryEl = document.createElement("div");
  summaryEl.className = "plan-review-bar-detail";
  const summaryTextEl = document.createElement("div");
  summaryTextEl.className = "plan-review-bar-detail-text";
  const summaryText = options.summary?.trim();
  summaryTextEl.textContent =
    summaryText || "Review the plan document, then Approve or Discard.";
  summaryEl.append(summaryTextEl);

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
