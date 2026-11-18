
import { el } from "./render.js";
import { icon } from "./icons.js";
import { parseMarkdownBlocks, renderMarkdownBlocks } from "./markdown.js";

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
  const bar = el("div", { class: "plan-review-bar" });

  const header = el("div", { class: "plan-review-bar-header" });
  const main = el("div", { class: "plan-review-bar-main" },
    el("span", { class: "plan-review-bar-icon" }, icon("fileText", 16)),
    el("div", { class: "plan-review-bar-title" }, "Plan ready for review"),
  );
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


export interface PlanReviewTarget {
  status: string;
  planDoc?: {
    path: string;
    summary: string;
    approvalPending?: boolean;
  } | null;
}

export interface PlanReviewDeps {
  runAction: (
    action: "approvePlan" | "discardPlan",
  ) => Promise<{ ok: boolean; error?: string }>;
  loadMarkdown: (path: string) => Promise<string | null>;
  onAfterAction: () => void;
}

export type PlanReviewSync = {
  host: HTMLElement;
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
      if (exiting) return Promise.resolve();
      host.replaceChildren();
      host.hidden = true;
      return Promise.resolve();
    }
    exiting = api.root;
    host.classList.remove("is-open");
    return Promise.all([api.playExit()]).then(() => {
      if (exiting === api.root) exiting = null;
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
    void dismiss();
    try {
      const result = await deps.runAction(action);
      if (!result || result.ok !== true) {
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
    if (actionInFlight) return;
    const summary = session.planDoc?.summary;
    const docPath = session.planDoc?.path;
    if (docPath !== lastDocPath) markdown = null;
    const prevSummary = lastSummary;
    const prevDocPath = lastDocPath;
    lastSummary = summary;
    lastDocPath = docPath;
    const pendingError = error;
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
