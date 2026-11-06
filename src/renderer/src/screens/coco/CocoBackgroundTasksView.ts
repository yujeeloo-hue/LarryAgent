import type { CocoBackgroundTask } from "../../../../coco/types.js";
import { setReasoningTitle } from "../../ui/reasoningTitle.js";
import { el } from "./dom.js";

const purposeLabel = (purpose: string): string => ({ greet: "Conversation", recover: "Recovery", plan: "Planning", verify: "Acceptance", inspect: "Project review", report: "Report", retention: "History summary", decide: "Task decision" }[purpose] ?? "Task check");
const STATUS_FALLBACK = "Checking saved context…";
/** Mirrors --check-motion in coco.css (exit transition) — single source per surface. */
const MOTION_MS = 320;
const reducedMotion = (): boolean => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

type Row = { root: HTMLElement; title: HTMLElement; status: HTMLElement };

/**
 * Only currently running checks: one compact, non-interactive status row each
 * (no "Earlier checks" history, no expandable transcripts). Rows are
 * node-stable across snapshots — live progress updates roll the status text
 * per character via setReasoningTitle instead of remounting, so animations
 * never restart mid-stream.
 */
export class CocoBackgroundTasksView {
  readonly root = el("section", "coco-background-tasks");
  private rows = new Map<string, Row>();
  private exiting = new Set<HTMLElement>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  constructor() {
    this.root.setAttribute("aria-label", "CoCo tasks");
    this.root.hidden = true;
  }
  /** Returns true when a row was added or removed (height changed) — not on progress-only ticks. */
  update(tasks: CocoBackgroundTask[]): boolean {
    const running = tasks.filter(task => task.status === "running" && task.purpose !== "greet").sort((a, b) => a.startedAt - b.startedAt);
    const ids = new Set(running.map(task => task.id));
    let structural = false;
    for (const [id, row] of this.rows) if (!ids.has(id)) { this.rows.delete(id); this.exit(row.root); structural = true; }
    for (const task of running) {
      let row = this.rows.get(task.id);
      if (!row) {
        const root = el("div", "coco-background-row");
        root.setAttribute("role", "status");
        const spinner = el("span", "session-running-spinner");
        spinner.setAttribute("aria-hidden", "true");
        const label = el("span", "coco-background-label");
        const title = el("strong"), sep = el("span", "coco-background-sep", "·"), status = el("span", "coco-background-status");
        label.append(title, sep, status);
        root.append(spinner, label);
        row = { root, title, status };
        this.rows.set(task.id, row);
        this.root.append(root);
        structural = true;
      }
      const heading = `${purposeLabel(task.purpose)} · ${task.title}`;
      if (row.title.textContent !== heading) row.title.textContent = heading;
      row.root.setAttribute("aria-label", heading);
      setReasoningTitle(row.status, task.progress || STATUS_FALLBACK);
    }
    this.root.hidden = !this.rows.size && !this.exiting.size;
    return structural;
  }
  /** Fade-and-rise out, then detach; reduced motion removes immediately. */
  private exit(root: HTMLElement): void {
    if (reducedMotion()) { root.remove(); return; }
    this.exiting.add(root);
    root.classList.add("is-out");
    const timer = setTimeout(() => { this.timers.delete(timer); this.exiting.delete(root); root.remove(); this.root.hidden = !this.rows.size && !this.exiting.size; }, MOTION_MS);
    this.timers.add(timer);
  }
  destroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear(); this.exiting.clear();
    for (const row of this.rows.values()) row.root.remove();
    this.rows.clear();
    this.root.remove();
  }
}
