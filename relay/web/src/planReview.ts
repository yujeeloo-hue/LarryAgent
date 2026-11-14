/**
 * Plan approval bar — web port of the desktop PlanReviewBarView.ts +
 * the ConversationController plan-review sync.
 *
 * The bar is sticky chrome in the composer stack (status row → THIS →
 * queue → composer card) shown when planDoc.approvalPending is set and the
 * session is not running. Approve / Discard ride the existing device
 * actions (`approvePlan` / `discardPlan`); the Detail toggle expands an
 * inline markdown preview loaded through `readTextFile`.
 *
 * Desktop parity notes:
 *  - folds are class-driven (desktop measures inline max-height; the port
 *    caps in CSS — see .plan-review-host / .plan-review-bar-preview)
 *  - Approve/Discard dismiss optimistically; a bounced result re-mounts
 *    the bar carrying the device error text
 *  - the desktop chime is deliberately NOT ported
 */

import { el } from "./render.js";
import { icon } from "./icons.js";
import { parseMarkdownBlocks, renderMarkdownBlocks } from "./markdown.js";

/** Real transition environment (Chrome). Linkedom tests run without it. */
const animated =
  typeof requestAnimationFrame === "function" &&
  typeof TransitionEvent !== "undefined";

function waitForTransition(
  node: HTMLElement,
  properties: string[],
  timeoutMs: number,
): Promise<void> {
  if (!animated) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      node.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (ev: Event): void => {
      const propertyName = (ev as TransitionEvent).propertyName;
      if (properties.includes(propertyName)) finish();
    };
    node.addEventListener("transitionend", onEnd);
    window.setTimeout(finish, timeoutMs);
  });
}

export type PlanReviewBarOptions = {
  summary?: string;
  docPath?: string;
  busy?: boolean;
  error?: string | null;
  /** Restore the expanded preview after a rebuild. */
  expanded?: boolean;
  /** Cached markdown body when already loaded. */
  markdown?: string | null;
  onApprove: () => void;
  onDiscard: () => void;
  /** Load the plan doc markdown for the inline preview; null/empty = failure. */
  onLoadMarkdown?: () => Promise<string | null>;
  onExpandedChange?: (expanded: boolean) => void;
  onMarkdownLoaded?: (markdown: string) => void;
};

export type PlanReviewBarApi = {
  root: HTMLElement;
  isExpanded: () => boolean;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  /** Collapse (if expanded) then run the action — Approve / Discard. */
  collapseThen: (action: () => void) => void;
  /** Slide up + fade in from below (first mount only). */
  playEnter: () => void;
  /** Slide down + fade out; resolves when the host may unmount. */
  playExit: () => Promise<void>;
};

export function createPlanReviewBar(
  options: PlanReviewBarOptions,
): PlanReviewBarApi {
  const bar = el("div", { class: "plan-review-bar" });

  const header = el("div", { class: "plan-review-bar-header" });
  const main = el("div", { class: "plan-review-bar-main" },
    el("span", { class: "plan-review-bar-icon" }, icon("fileText", 16)),
    el("div", { class: "plan-review-bar-title" }, "Plan ready for review"),
  );
  // Collapsed-only hint; folds away while the doc preview opens.
  const summaryText = options.summary?.trim();
  const summaryEl = el("div", { class: "plan-review-bar-detail" },
    el("div", { class: "plan-review-bar-detail-text" },
      summaryText || "Review the plan document, then Approve or Discard."));
  header.append(main, summaryEl);

  const detailBtn = el("button", {
    class: "plan-review-bar-btn plan-review-bar-btn-secondary",
    type: "button",
  }, icon("chevronUp", 14), el("span", {}, "Detail")) as HTMLButtonElement;
  detailBtn.hidden = !options.docPath;

  const discardBtn = el("button", {
    class: "plan-review-bar-btn plan-review-bar-btn-secondary action-danger",
    type: "button",
  }, "Discard") as HTMLButtonElement;
  const approveBtn = el("button", {
    class: "plan-review-bar-btn plan-review-bar-btn-primary action-primary",
    type: "button",
  }, "Approve") as HTMLButtonElement;

  const actions = el("div", { class: "plan-review-bar-actions" });
  if (options.docPath) actions.append(detailBtn);
  actions.append(discardBtn, approveBtn);

  const previewInner = el("div", { class: "plan-review-bar-preview-inner" });
  const previewBody = el("div", { class: "plan-review-bar-preview-body md-blocks" });
  previewInner.append(previewBody);
  const preview = el("div", { class: "plan-review-bar-preview" }, previewInner);

  const errorEl = el("div", { class: "plan-review-bar-error", hidden: true });

  // Actions sit after the preview so expanding pushes the doc in above them
  // instead of lifting the buttons to the top of the panel.
  bar.append(header, preview, actions, errorEl);

  let expanded = false;
  let busyNow = Boolean(options.busy);
  let markdownCache: string | null =
    typeof options.markdown === "string" ? options.markdown : null;
  let loadInFlight: Promise<void> | null = null;

  function setError(error: string | null): void {
    const text = error?.trim() ?? "";
    errorEl.hidden = !text;
    errorEl.textContent = text;
  }

  function syncDetailButton(): void {
    // Chevron flips with state; wrapped so the svg markup parses into nodes.
    detailBtn.replaceChildren(
      el("span", {}, icon(expanded ? "chevronDown" : "chevronUp", 14)),
      el("span", {}, "Detail"),
    );
    detailBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    detailBtn.title = expanded ? "Collapse plan document" : "Expand plan document";
  }

  function renderPreview(markdown: string): void {
    previewBody.replaceChildren();
    try {
      renderMarkdownBlocks(parseMarkdownBlocks(markdown), previewBody);
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
    return Promise.resolve();
  }

  async function expandAndLoad(): Promise<void> {
    // Render content before opening so the animation targets final height.
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
          previewBody.textContent = err instanceof Error ? err.message : String(err);
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
    if (busyNow) return;
    if (expanded) {
      void setExpanded(false);
      return;
    }
    void expandAndLoad();
  });
  discardBtn.addEventListener("click", () => {
    if (busyNow) return;
    collapseThen(() => options.onDiscard());
  });
  approveBtn.addEventListener("click", () => {
    if (busyNow) return;
    collapseThen(() => options.onApprove());
  });

  if (options.error?.trim()) setError(options.error);
  syncDetailButton();

  if (busyNow) {
    discardBtn.disabled = true;
    approveBtn.disabled = true;
    detailBtn.disabled = true;
  }

  if (options.expanded && options.docPath) {
    // Rebuilds restore the open state instantly; only user clicks animate.
    expanded = true;
    bar.classList.add("is-expanded");
    syncDetailButton();
    void expandAndLoad();
  }

  return {
    root: bar,
    isExpanded: () => expanded,
    setBusy: (busy: boolean) => {
      busyNow = busy;
      discardBtn.disabled = busy;
      approveBtn.disabled = busy;
      detailBtn.disabled = busy;
    },
    setError,
    collapseThen,
    playEnter: () => {
      if (!animated) return;
      bar.classList.add("is-fold-in");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          bar.classList.remove("is-fold-in");
        });
      });
    },
    playExit: () => {
      if (!animated) return Promise.resolve();
      bar.classList.add("is-fold-out");
      return waitForTransition(bar, ["transform", "opacity"], 320);
    },
  };
}

// ── sync controller (ConversationController plan-review port) ─────────

/** Session shape the sync needs — the full Session snapshot carries it. */
export interface PlanReviewTarget {
  status: string;
  planDoc?: {
    path: string;
    summary: string;
    approvalPending?: boolean;
  } | null;
}

export interface PlanReviewDeps {
  /** Invoke the device action; resolves with its result payload. */
  runAction: (
    action: "approvePlan" | "discardPlan",
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Load the plan doc body (readTextFile); null = failure. */
  loadMarkdown: (path: string) => Promise<string | null>;
  /** Fired after a successful action (host refreshes the session). */
  onAfterAction: () => void;
}

export type PlanReviewSync = {
  /** Persistent host node — re-append into every composer rebuild. */
  host: HTMLElement;
  /** Mount / keep / dismiss against a fresh session snapshot. */
  sync: (session: PlanReviewTarget) => void;
};

export function createPlanReviewSync(deps: PlanReviewDeps): PlanReviewSync {
  const host = el("div", { class: "plan-review-host" }) as HTMLElement;
  host.hidden = true;

  let barApi: PlanReviewBarApi | null = null;
  let lastSummary: string | undefined;
  let lastDocPath: string | undefined;
  let expanded = false;
  let markdown: string | null = null;
  let error: string | null = null;
  let actionInFlight = false;
  let exiting: HTMLElement | null = null;

  function dismiss(): Promise<void> {
    const api = barApi;
    barApi = null;
    error = null;
    expanded = false;
    markdown = null;
    lastSummary = undefined;
    lastDocPath = undefined;
    if (!api) {
      // Repeat calls while the previous panel is still sliding out.
      if (exiting) return Promise.resolve();
      host.replaceChildren();
      host.hidden = true;
      return Promise.resolve();
    }
    exiting = api.root;
    host.classList.remove("is-open");
    return Promise.all([api.playExit()]).then(() => {
      if (exiting === api.root) exiting = null;
      // A new panel may have mounted meanwhile — only clear our own node.
      if (api.root.parentElement === host) api.root.remove();
      if (!barApi) host.hidden = true;
    });
  }

  function restore(message: string): void {
    error = message;
  }

  async function runAction(action: "approvePlan" | "discardPlan"): Promise<void> {
    if (actionInFlight) return;
    actionInFlight = true;
    error = null;
    // Optimistic: the panel leaves right away (Approve starts execution).
    void dismiss();
    try {
      const result = await deps.runAction(action);
      if (!result || result.ok !== true) {
        // Still in review — the next sync re-mounts carrying the reason.
        restore(
          (result && typeof result.error === "string" && result.error) ||
            `${action === "approvePlan" ? "Approve" : "Discard"} failed.`,
        );
        deps.onAfterAction();
        return;
      }
      deps.onAfterAction();
    } catch (err) {
      restore(err instanceof Error ? err.message : String(err));
      deps.onAfterAction();
    } finally {
      actionInFlight = false;
    }
  }

  function sync(session: PlanReviewTarget): void {
    const active =
      session.planDoc?.approvalPending === true && session.status !== "running";
    if (!active) {
      void dismiss();
      return;
    }
    // While an optimistic approve/discard is in flight the bar stays down —
    // a racing resync must not resurrect it just to dismiss again.
    if (actionInFlight) return;
    const summary = session.planDoc?.summary;
    const docPath = session.planDoc?.path;
    if (docPath !== lastDocPath) markdown = null;
    const prevSummary = lastSummary;
    const prevDocPath = lastDocPath;
    lastSummary = summary;
    lastDocPath = docPath;
    const pendingError = error;
    // Keep the live panel unless content moved (restart animations, drop
    // the open preview) — metadata refreshes land constantly.
    if (barApi && summary === prevSummary && docPath === prevDocPath) {
      if (pendingError) {
        barApi.setError(pendingError);
        error = null;
      }
      return;
    }
    const entering = !barApi;
    const api = createPlanReviewBar({
      ...(summary !== undefined ? { summary } : {}),
      ...(docPath !== undefined ? { docPath } : {}),
      busy: false,
      error: pendingError,
      expanded,
      markdown,
      onApprove: () => void runAction("approvePlan"),
      onDiscard: () => void runAction("discardPlan"),
      onExpandedChange: (next) => {
        expanded = next;
      },
      onMarkdownLoaded: (md) => {
        markdown = md;
      },
      onLoadMarkdown: async () => {
        if (!docPath) return null;
        if (markdown) return markdown;
        return deps.loadMarkdown(docPath);
      },
    });
    error = null;
    barApi = api;
    exiting = null;
    if (entering) {
      // Start folded so the panel rises into a growing host instead of
      // popping the transcript up by its full height in one frame. The
      // reflow between unhide and is-open lets the max-height transition
      // actually run.
      host.replaceChildren(api.root);
      host.hidden = false;
      void host.offsetHeight;
      api.playEnter();
      host.classList.add("is-open");
    } else {
      host.replaceChildren(api.root);
    }
  }

  return { host, sync };
}
