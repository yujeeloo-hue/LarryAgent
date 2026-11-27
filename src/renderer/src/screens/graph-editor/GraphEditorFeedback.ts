import { ArrowUpRight, CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert, X } from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import type { GraphIssue, GraphValidation } from "../../../../agent/fsm/authoring/diagnostics.js";
import "./graph-editor-feedback.css";

export type GraphEditorNotice = {
  tone: "success" | "warning" | "error" | "info" | "loading";
  title: string;
  description?: string;
  source?: "validation" | "save" | "editor";
  action?: { label: string; run: () => void };
  durationMs?: number;
};

const issueTitles: Record<string, string> = {
  ACTION_PREREQUISITE_MISSING: "Action prerequisite is missing",
  TOOLS_NOT_PREPARED: "Tools are not prepared",
  EMPTY_ROUTE_MAPPING: "Route mapping is missing",
  MISSING_ROUTE_PRODUCER: "Route action is missing",
  UNWIRED_ROUTE_PIN: "Output pin is not connected",
  UNKNOWN_PIN: "Pin reference is invalid",
  NON_TERMINAL_NO_OUTGOING: "Node has no outgoing connection",
  EDGE_ALWAYS_NOT_ALONE: "Unconditional connection conflicts with a branch",
  DANGLING_EDGE: "Connection endpoint is missing",
  UNREACHABLE_NODE: "Node cannot be reached",
  TERMINAL_UNREACHABLE: "End node cannot be reached",
  INVALID_ACTION_PARAMS: "Action parameters need attention",
};

export class GraphEditorFeedback {
  readonly root = document.createElement("div");
  private timer: ReturnType<typeof setTimeout> | null = null;
  private remainingMs = 0;
  private startedAt = 0;
  private source: GraphEditorNotice["source"];
  private details: HTMLElement | null = null;
  private detailsButton: HTMLButtonElement | null = null;
  private progress: HTMLElement | null = null;
  private hovering = false;
  private focused = false;

  constructor() {
    this.root.className = "graph-editor-feedback";
    this.root.hidden = true;
    this.root.addEventListener("mouseenter", () => { this.hovering = true; this.pause(); });
    this.root.addEventListener("mouseleave", () => { this.hovering = false; this.resume(); });
    this.root.addEventListener("focusin", () => { this.focused = true; this.pause(); });
    this.root.addEventListener("focusout", event => {
      if (event.relatedTarget instanceof Node && this.root.contains(event.relatedTarget)) return;
      this.focused = false;
      this.resume();
    });
    this.root.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      this.escape();
    });
  }

  show(notice: GraphEditorNotice): void {
    this.dismiss();
    this.source = notice.source;
    this.root.dataset.tone = notice.tone;
    this.root.setAttribute("role", notice.tone === "error" ? "alert" : "status");
    this.root.setAttribute("aria-live", notice.tone === "error" ? "assertive" : "polite");
    const head = document.createElement("div");
    head.className = "graph-editor-feedback-head";
    const icon = document.createElement("span");
    icon.className = "graph-editor-feedback-icon";
    const icons = { error: CircleAlert, warning: TriangleAlert, success: CircleCheck, info: Info, loading: LoaderCircle };
    icon.append(createLucideIcon(icons[notice.tone], { size: 16 }));
    const copy = document.createElement("div");
    copy.className = "graph-editor-feedback-copy";
    const title = document.createElement("div");
    title.className = "graph-editor-feedback-title";
    title.textContent = notice.title;
    copy.append(title);
    if (notice.description) {
      const description = document.createElement("p");
      description.className = "graph-editor-feedback-description";
      description.textContent = notice.description;
      copy.append(description);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "graph-editor-feedback-close";
    close.setAttribute("aria-label", "Dismiss notification");
    close.append(createLucideIcon(X, { size: 14 }));
    close.addEventListener("click", () => this.dismiss());
    head.append(icon, copy, close);
    this.root.append(head);
    if (notice.action) {
      const actions = document.createElement("div");
      actions.className = "graph-editor-feedback-actions";
      const button = document.createElement("button");
      button.type = "button";
      button.className = "graph-editor-feedback-action";
      button.textContent = notice.action.label;
      button.addEventListener("click", notice.action.run);
      actions.append(button);
      this.root.append(actions);
    }
    this.root.hidden = false;
    if (notice.tone === "success" || notice.tone === "info") {
      this.remainingMs = notice.durationMs ?? 3500;
      const track = document.createElement("div");
      track.className = "graph-editor-feedback-progress";
      this.progress = document.createElement("span");
      this.progress.style.animationDuration = `${this.remainingMs}ms`;
      track.append(this.progress);
      this.root.append(track);
      this.resume();
    }
  }

  showValidation(validation: GraphValidation, locate: (issue: GraphIssue) => boolean, locationLabel?: (issue: GraphIssue) => string): void {
    const errors = validation.errors;
    const warnings = validation.warnings;
    const summary = `${errors} ${errors === 1 ? "error" : "errors"} and ${warnings} ${warnings === 1 ? "warning" : "warnings"}.`;
    this.show({
      tone: errors ? "error" : warnings ? "warning" : "success",
      title: errors ? "Graph needs attention" : warnings ? `Valid with ${warnings} ${warnings === 1 ? "warning" : "warnings"}` : "Validation passed",
      description: errors ? `${summary} Fix the errors before enabling.` : warnings ? "You can enable this graph. Review the warnings first." : "Your graph is ready to enable.",
      source: "validation",
    });
    if (!validation.issues.length) return;
    const actions = document.createElement("div");
    actions.className = "graph-editor-feedback-actions";
    this.detailsButton = document.createElement("button");
    this.detailsButton.type = "button";
    this.detailsButton.className = "graph-editor-feedback-action";
    this.detailsButton.textContent = "View issues";
    this.detailsButton.setAttribute("aria-expanded", "false");
    this.details = document.createElement("div");
    this.details.className = "graph-editor-feedback-details";
    this.details.hidden = true;
    this.detailsButton.addEventListener("click", () => {
      if (!this.details || !this.detailsButton) return;
      this.details.hidden = !this.details.hidden;
      this.detailsButton.textContent = this.details.hidden ? "View issues" : "Hide details";
      this.detailsButton.setAttribute("aria-expanded", String(!this.details.hidden));
    });
    actions.append(this.detailsButton);
    for (const issue of validation.issues) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "graph-editor-feedback-issue";
      button.dataset.severity = issue.severity;
      const heading = document.createElement("span");
      heading.className = "graph-editor-feedback-issue-title";
      heading.append(createLucideIcon(issue.severity === "error" ? CircleAlert : TriangleAlert, { size: 13 }));
      const title = document.createElement("span");
      title.textContent = issueTitles[issue.code] ?? (issue.severity === "error" ? "Graph configuration needs attention" : "Review this configuration");
      heading.append(title);
      const description = document.createElement("span");
      description.className = "graph-editor-feedback-issue-message";
      description.textContent = `${issue.message} ${issue.suggestion}`;
      const location = document.createElement("span");
      location.className = "graph-editor-feedback-issue-location";
      location.append(document.createTextNode(locationLabel?.(issue) ?? issue.nodeId ?? issue.edgeId ?? issue.path), createLucideIcon(ArrowUpRight, { size: 12 }));
      button.append(heading, description, location);
      button.addEventListener("click", () => {
        if (locate(issue)) this.collapseDetails();
      });
      this.details.append(button);
    }
    this.root.append(actions, this.details);
  }

  dismiss(source?: GraphEditorNotice["source"]): void {
    if (source && this.source !== source) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.remainingMs = 0;
    this.source = undefined;
    this.details = null;
    this.detailsButton = null;
    this.progress = null;
    this.focused = false;
    this.root.hidden = true;
    this.root.replaceChildren();
  }

  destroy(): void {
    this.dismiss();
    this.root.remove();
  }

  escape(): boolean {
    if (this.root.hidden) return false;
    if (this.details && !this.details.hidden) this.collapseDetails();
    else this.dismiss();
    return true;
  }

  private collapseDetails(): void {
    if (this.details) this.details.hidden = true;
    if (this.detailsButton) {
      this.detailsButton.textContent = "View issues";
      this.detailsButton.setAttribute("aria-expanded", "false");
    }
  }

  private pause(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.remainingMs = Math.max(0, this.remainingMs - (Date.now() - this.startedAt));
      this.timer = null;
    }
    if (this.progress) this.progress.style.animationPlayState = "paused";
  }

  private resume(): void {
    if (this.hovering || this.focused || this.timer || !this.remainingMs) return;
    this.startedAt = Date.now();
    if (this.progress) this.progress.style.animationPlayState = "running";
    this.timer = setTimeout(() => this.dismiss(), this.remainingMs);
  }
}
