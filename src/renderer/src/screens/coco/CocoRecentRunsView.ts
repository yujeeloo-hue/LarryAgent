import { CalendarDays, ChevronRight, CircleCheck, CircleDashed, Hourglass, Layers2, createElement } from "lucide";
import { ruleRunAcceptance, ruleRunAt, type CocoRuleRunAcceptance } from "../../../../coco/ruleRuns.js";
import type { CocoRuleRun, CocoSnapshot, CocoWork } from "../../../../coco/types.js";
import { parseMarkdownBlocks } from "../../markdown/parseMarkdownBlocks.js";
import type { DisplayBlock, InlineNode } from "../../markdown/types.js";
import { createLucideIcon } from "../../ui/icons.js";
import { renderMarkdownText } from "../conversation/renderMarkdownText.js";
import { button, el } from "./dom.js";

type RunsSnapshot = Pick<CocoSnapshot, "ruleRuns" | "work" | "verifications" | "workspaces" | "settings">;
const VISIBLE_RUNS = 10;
const active = (run: CocoRuleRun): boolean => run.status === "running" || run.status === "retrying";
const statusLabels: Record<CocoRuleRun["status"], string> = { running: "Running", retrying: "Retrying", no_action: "No action needed", planned: "Work planned", failed: "Failed" };
const workLabels: Record<CocoWork["status"], string> = { draft: "Draft", queued: "Queued", executing: "Executing", recovering: "Recovering", verifying: "Verifying", waiting: "Waiting", to_decide: "To decide", completed: "Verified", cancelled: "Cancelled" };

const inlineText = (nodes: InlineNode[]): string => nodes.map(node => "children" in node ? inlineText(node.children) : "text" in node ? node.text : node.type === "image" ? node.alt : " ").join("");
const blockText = (block: DisplayBlock): string => {
  switch (block.kind) {
    case "paragraph": case "heading": return inlineText(block.children);
    case "list": return block.items.map(item => inlineText(item.children)).join(" ");
    case "blockquote": return block.children.map(blockText).join(" ");
    case "code": return block.text;
    case "image": return block.alt;
    case "table": return [...block.header, ...block.rows.flat()].map(inlineText).join(" ");
    case "hr": return "";
  }
};
const previewText = (markdown: string): string => {
  const blocks = parseMarkdownBlocks(markdown);
  // A leading Markdown heading is usually a label; preview the conclusion below it.
  const content = blocks.filter(block => block.kind !== "heading");
  return (content.length ? content : blocks).map(blockText).join(" ").replace(/\s+/g, " ").trim();
};
const dayKey = (at: number, timezone: string): string => {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
};
const dayLabel = (at: number, now: number, timezone: string): string => {
  const key = dayKey(at, timezone), today = dayKey(now, timezone);
  if (key === today) return "Today";
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  if (key === yesterday) return "Yesterday";
  return new Date(at).toLocaleDateString([], { timeZone: timezone, month: "short", day: "numeric", ...(key.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) });
};
const clockTime = (at: number, timezone: string): string => new Date(at).toLocaleTimeString([], { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const duration = (run: CocoRuleRun): string => {
  if (run.endedAt === undefined || run.endedAt < run.startedAt) return "";
  const seconds = Math.round((run.endedAt - run.startedAt) / 1000);
  const value = seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
  return `${run.status === "failed" ? "Ended after" : "Completed in"} ${value}`;
};

/** Overview timeline. Expansion is local UI state and never changes a saved run. */
export class CocoRecentRunsView {
  readonly root = el("section", "coco-section coco-runs");
  private expanded = new Set<string>();
  private now = 0;

  constructor(private openWork: (work: CocoWork) => void, private layoutChanged: () => void) {}

  render(snapshot: RunsSnapshot, now = Date.now()): HTMLElement {
    this.now = now;
    const runs = [...(snapshot.ruleRuns ?? [])].sort((a, b) => ruleRunAt(b) - ruleRunAt(a));
    const ids = new Set(runs.map(run => run.id));
    for (const id of this.expanded) if (!ids.has(id)) this.expanded.delete(id);
    const current = runs.filter(active), history = runs.filter(run => !active(run));
    const recentCount = Math.max(0, VISIBLE_RUNS - current.length);
    const visibleCurrent = current.slice(0, VISIBLE_RUNS);
    const visibleHistory = history.slice(0, recentCount);
    const header = el("div", "coco-runs-head"), meta = el("span", "coco-runs-meta");
    header.append(el("h3", "", "Recent runs"));
    if (current.length) meta.append(el("span", "coco-runs-active", `${current.length} in progress`));
    if (runs.length) meta.append(el("span", "", `${runs.length} ${runs.length === 1 ? "run" : "runs"}`));
    header.append(meta); this.root.replaceChildren(header);
    if (!runs.length) {
      this.root.append(el("p", "coco-muted coco-runs-empty", "Rule activity, summaries and task acceptance will appear here."));
      return this.root;
    }
    const feed = el("div", "coco-runs-feed"); this.root.append(feed);
    if (visibleCurrent.length) feed.append(this.group("In progress", visibleCurrent, snapshot, Hourglass));
    const days = new Map<string, CocoRuleRun[]>();
    for (const run of visibleHistory) {
      const key = dayKey(ruleRunAt(run), snapshot.settings.timezone);
      const group = days.get(key) ?? []; group.push(run); days.set(key, group);
    }
    for (const group of days.values()) feed.append(this.group(dayLabel(ruleRunAt(group[0]!), now, snapshot.settings.timezone), group, snapshot));
    return this.root;
  }

  private group(label: string, runs: CocoRuleRun[], snapshot: RunsSnapshot, icon = CalendarDays): HTMLElement {
    const group = el("div", "coco-runs-group"), day = el("h4", "coco-runs-day");
    const marker = el("span", "coco-runs-day-marker"); marker.setAttribute("aria-hidden", "true");
    // Keep timeline markers outlined so they stay light beside the run dots.
    marker.append(createElement(icon, { width: 14, height: 14, "stroke-width": 1.6, "aria-hidden": "true" }));
    day.append(marker, el("span", "coco-runs-day-label", label)); group.append(day);
    const timeline = el("div", "coco-runs-timeline");
    for (const run of runs) timeline.append(this.run(run, snapshot));
    group.append(timeline); return group;
  }

  private run(run: CocoRuleRun, snapshot: RunsSnapshot): HTMLElement {
    const item = el("details", `coco-run run-${run.status}`); item.dataset.runId = run.id;
    const trigger = el("summary", "coco-run-trigger"), time = el("time", "coco-run-time");
    const timezone = snapshot.settings.timezone;
    const at = ruleRunAt(run), chat = run.source === "chat";
    time.dateTime = new Date(at).toISOString(); time.textContent = clockTime(at, timezone);
    time.title = new Date(at).toLocaleString([], { timeZone: timezone });
    const dot = el("span", "coco-run-dot"); dot.setAttribute("aria-hidden", "true");
    const copy = el("span", "coco-run-copy"), head = el("span", "coco-run-head");
    let status = chat && run.endedAt !== undefined ? "Completed" : statusLabels[run.status];
    if (run.status === "retrying" && run.retryAt) {
      const day = dayKey(run.retryAt, timezone) === dayKey(this.now, timezone) ? "" : `${dayLabel(run.retryAt, this.now, timezone)} `;
      status = `Retrying at ${day}${clockTime(run.retryAt, timezone)}`;
    }
    head.append(el("strong", "coco-run-title", run.ruleName), el("span", "coco-run-status", status)); copy.append(head);
    const metadata = [duration(run), run.attempts > 1 ? `${run.attempts} attempts` : ""].filter(Boolean);
    // Active runs can cross a day boundary; retain their date next to the clock.
    if (active(run)) metadata.unshift(dayLabel(run.startedAt, this.now, timezone));
    if (metadata.length) copy.append(el("span", "coco-run-meta", metadata.join(" · ")));
    const fallback = chat ? (run.status === "running" ? "CoCo is working on this request…" : "Work planned from your chat request.") : run.status === "running" ? "CoCo is reviewing this rule…" : run.status === "retrying" ? "This run will retry automatically." : run.status === "failed" ? "This run could not be completed. Expand to review the error." : run.status === "planned" ? "Work has been planned for this rule." : "No new work was needed.";
    copy.append(el("span", "coco-run-preview", run.summary ? previewText(run.summary) || fallback : fallback));
    const acceptance = ruleRunAcceptance(run, snapshot.work, snapshot.verifications);
    if (acceptance.length) copy.append(this.outcomes(acceptance));
    const chevron = createLucideIcon(ChevronRight, { size: 13 }); chevron.classList.add("coco-run-chevron");
    trigger.append(time, dot, copy, chevron); item.append(trigger);
    const detail = el("div", "coco-run-detail"); item.append(detail);
    const showDetails = (): void => {
      if (detail.childElementCount) return;
      const summary = el("div", "coco-run-detail-block"); summary.append(el("h4", "coco-run-label", "Summary"));
      const body = el("div", "coco-prose coco-report-body coco-run-summary");
      if (run.summary) renderMarkdownText(run.summary, body); else body.append(el("p", "", fallback));
      summary.append(body); detail.append(summary);
      if (run.error && (run.status === "failed" || run.status === "retrying")) {
        const error = el("div", "coco-run-detail-block"); error.append(el("h4", "coco-run-label", "Last attempt"), el("p", "coco-run-error", run.error)); detail.append(error);
      }
      if (acceptance.length) detail.append(this.tasks(acceptance, snapshot));
      else if (run.workIds.length) detail.append(el("p", "coco-muted", "The tasks planned by this run are no longer available."));
    };
    item.open = this.expanded.has(run.id);
    if (item.open) showDetails();
    item.ontoggle = () => {
      // Ignore queued events from rows replaced by a newer snapshot.
      if (!this.root.contains(item)) return;
      if (item.open) { this.expanded.add(run.id); showDetails(); } else this.expanded.delete(run.id);
      this.layoutChanged();
    };
    return item;
  }

  private outcomes(acceptance: CocoRuleRunAcceptance[]): HTMLElement {
    const outcomes = el("span", "coco-run-outcomes");
    const add = (label: string, icon: typeof Layers2): void => {
      const part = el("span", "coco-run-outcome"); part.append(createLucideIcon(icon, { size: 12 }), document.createTextNode(label)); outcomes.append(part);
    };
    add(`${acceptance.length} ${acceptance.length === 1 ? "task" : "tasks"}`, Layers2);
    const verified = acceptance.filter(result => result.status === "completed" && result.tone === "passed").length;
    const attention = acceptance.filter(result => result.tone === "failed").length;
    const pending = acceptance.filter(result => result.tone === "pending").length;
    if (verified) add(`${verified} verified`, CircleCheck);
    if (attention) add(`${attention} to review`, CircleDashed);
    if (pending) add(`${pending} pending`, CircleDashed);
    return outcomes;
  }

  private tasks(acceptance: CocoRuleRunAcceptance[], snapshot: RunsSnapshot): HTMLElement {
    const list = el("div", "coco-run-detail-block coco-run-tasks"); list.append(el("h4", "coco-run-label", "Tasks & acceptance"));
    for (const result of acceptance) {
      const work = snapshot.work.find(work => work.id === result.workId)!;
      const row = button("", () => this.openWork(work)); row.className = "coco-run-task";
      const head = el("span", "coco-run-task-head");
      head.append(el("span", "coco-run-task-title", result.title), el("span", `coco-run-task-status ${result.status}`, workLabels[result.status]));
      const metadata = el("span", "coco-run-task-meta");
      metadata.append(el("span", "", snapshot.workspaces.find(project => project.id === work.workspaceId)?.name ?? "Unavailable project"), el("span", `coco-run-result is-${result.tone}`, result.summary));
      row.append(head, metadata); list.append(row);
    }
    return list;
  }
}
