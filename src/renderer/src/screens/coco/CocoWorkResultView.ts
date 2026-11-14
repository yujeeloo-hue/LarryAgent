import { ArrowUpRight, Check, ChevronDown, Copy, Download, FileText, Pause, RotateCcw, CircleHelp, X } from "lucide";
import type { CocoSnapshot, CocoTimelineEntry, CocoWork, CocoWorkResult, CocoWorkStatus } from "../../../../coco/types.js";
import { createLucideIcon } from "../../ui/icons.js";
import { AppDropdown } from "../../ui/appDropdown.js";
import { renderMarkdownText } from "../conversation/renderMarkdownText.js";
import { button, el } from "./dom.js";

type DetailSnapshot = Pick<CocoSnapshot, "settings" | "attempts" | "verifications">;
type ResultActions = {
  load(workId: string): Promise<CocoWorkResult[]>;
  notice(text: string): void;
  layoutChanged(): void;
  openFile?(path: string): Promise<unknown>;
};
type TimelineEvent = CocoTimelineEntry & { result?: CocoWorkResult };
const statusTitles: Record<CocoWorkStatus, string> = {
  draft: "Plan saved", queued: "Queued", executing: "Execution started", recovering: "Recovering execution",
  verifying: "Checking acceptance", waiting: "Waiting", to_decide: "Your decision is needed", completed: "Verification passed", cancelled: "Cancelled",
};
const dayKey = (at: number, timeZone: string): string => new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
const clock = (at: number, timeZone: string): string => new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
const date = (at: number, timeZone: string): string => new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "short", day: "numeric" }).format(at);
const toolbarButton = (label: string, icon: typeof Copy, action: () => void): HTMLButtonElement => {
  const node = button(label, action); node.classList.add("coco-result-action"); node.prepend(createLucideIcon(icon, { size: 14 })); return node;
};

/** Output-first work detail; all sections share the page surface instead of nesting cards. */
export class CocoWorkResultView {
  readonly root = el("div", "coco-work-result-view");
  private work: CocoWork | undefined;
  private snapshot: DetailSnapshot | undefined;
  private key = "";
  private request = 0;
  private results: CocoWorkResult[] = [];
  private error = "";
  private loading = false;
  private destroyed = false;
  private selected = new Map<string, string>();
  private expanded = new Set<string>();
  private timelineExpanded = new Set<string>();
  private criteriaExpanded = new Set<string>();
  private feedback = el("p", "coco-result-feedback");
  constructor(private actions: ResultActions) { this.feedback.setAttribute("role", "status"); this.feedback.setAttribute("aria-live", "polite"); }
  private notice(text: string): void { this.feedback.textContent = text; this.actions.notice(text); }
  destroy(): void { this.destroyed = true; this.request++; }
  render(work: CocoWork, snapshot: DetailSnapshot): void {
    const changedWork = this.work?.id !== work.id;
    this.work = work; this.snapshot = snapshot;
    const attempts = snapshot.attempts.filter(attempt => attempt.workId === work.id);
    const key = JSON.stringify([work.id, work.revision, work.status, work.updatedAt, attempts]);
    if (key !== this.key) {
      this.key = key; this.error = "";
      if (changedWork) { this.results = []; this.feedback.textContent = ""; }
      this.loading = true;
      const request = ++this.request;
      void this.actions.load(work.id).then(results => {
        if (this.destroyed || request !== this.request) return;
        this.results = results.filter(result => result.workId === work.id); this.loading = false; this.paint();
      }, error => {
        if (this.destroyed || request !== this.request) return;
        this.loading = false; this.error = error instanceof Error ? error.message : String(error); this.paint();
      });
    }
    this.paint();
  }
  private paint(): void {
    const work = this.work, snapshot = this.snapshot;
    if (!work || !snapshot || this.destroyed) return;
    this.root.replaceChildren(this.reportSection(work, snapshot), this.timeline(work, snapshot), this.acceptance(work, snapshot), this.feedback);
    this.actions.layoutChanged();
  }
  private reportSection(work: CocoWork, snapshot: DetailSnapshot): HTMLElement {
    const section = el("section", "coco-detail-section coco-work-results"); section.setAttribute("aria-label", "Run results");
    // Reports take precedence over the execution reply from the same attempt.
    const reports = this.results.filter(result => result.source !== "message");
    const results = [...reports, ...this.results.filter(result => result.source === "message" && !reports.some(report => report.revision === result.revision && report.attemptId === result.attemptId))]
      .sort((a,b) => b.revision - a.revision || b.at - a.at);
    const heading = el("header", "coco-detail-section-heading");
    const title = el("h2", "", reports.length ? "Run report" : "Execution result");
    heading.append(title); section.append(heading);
    if (!results.length) {
      const message = this.loading ? "Loading saved results…" : this.error ? "Saved results could not be loaded." : ["completed", "cancelled"].includes(work.status)
        ? "No readable output was saved for this run. Open the execution task to review its original record."
        : "Saved reports and the execution result will appear here when available.";
      section.append(el("p", "coco-muted", message));
      if (this.error) {
        section.append(el("p", "coco-error", this.error), button("Retry", () => { this.key = ""; this.render(work, snapshot); }));
      }
      return section;
    }
    const selected = results.find(result => result.id === this.selected.get(work.id)) ?? results.find(result => result.revision === work.revision) ?? results[0]!;
    if (results.length > 1) {
      const field = el("label", "coco-result-picker");
      field.append(el("span", "coco-muted", "Saved output"));
      const picker = new AppDropdown(results.map(result => ({
        value: result.id,
        label: `${result.title} · ${date(result.at, snapshot.settings.timezone)} ${clock(result.at, snapshot.settings.timezone)} · Revision ${result.revision}`,
      })), selected.id, { ariaLabel: "Saved output" });
      picker.addEventListener("change", () => { this.selected.set(work.id, picker.value); this.paint(); });
      field.append(picker.el); section.append(field);
    }
    const actions = el("div", "coco-result-actions");
    actions.append(toolbarButton("Copy", Copy, () => {
      if (!navigator.clipboard) { this.notice("Could not copy the report. Try exporting it instead."); return; }
      void navigator.clipboard.writeText(selected.markdown).then(() => this.notice("Report copied."), () => this.notice("Could not copy the report. Try exporting it instead."));
    }), toolbarButton("Export Markdown", Download, () => {
      const url = URL.createObjectURL(new Blob([selected.markdown], { type: "text/markdown;charset=utf-8" }));
      const link = el("a"); link.href = url; link.download = `coco-result-${selected.at}.md`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }));
    heading.append(actions);
    const article = el("article", `coco-work-result-document${selected.source === "message" ? " is-execution-reply" : ""}`); article.id = `coco-result-${selected.id}`;
    const source = selected.imported ? "Imported from execution history" : selected.source === "message" ? "Execution reply" : "Saved report";
    const attemptIndex = snapshot.attempts.filter(attempt => attempt.workId === work.id).findIndex(attempt => attempt.id === selected.attemptId);
    const meta = [source, `${date(selected.at, snapshot.settings.timezone)} ${clock(selected.at, snapshot.settings.timezone)}`, snapshot.settings.timezone,
      attemptIndex >= 0 ? `Attempt ${attemptIndex + 1}` : "", selected.revision !== work.revision ? `Earlier requirements · Revision ${selected.revision}` : ""].filter(Boolean).join(" · ");
    article.append(el("p", "coco-result-meta coco-muted", meta));
    if (selected.source !== "message") article.append(el("h3", "coco-result-title", selected.title));
    const body = el("div", "coco-prose coco-report-body coco-work-result-body"); renderMarkdownText(selected.markdown, body);
    if (selected.source !== "message" && body.firstElementChild?.matches("h1,h2,h3") && body.firstElementChild.textContent?.trim() === selected.title.trim()) body.firstElementChild.remove();
    article.append(body);
    if (body.childElementCount > 5 && selected.markdown.length > 1600) {
      const toggle = button("", () => { if (this.expanded.has(selected.id)) this.expanded.delete(selected.id); else this.expanded.add(selected.id); update(); this.actions.layoutChanged(); });
      toggle.classList.add("coco-result-expand"); body.id = `coco-result-body-${selected.id}`; toggle.setAttribute("aria-controls", body.id);
      const update = (): void => {
        const open = this.expanded.has(selected.id);
        [...body.children].forEach((child, index) => { (child as HTMLElement).hidden = !open && index >= 5; });
        toggle.replaceChildren(document.createTextNode(open ? "Show less" : "Read full report"), createLucideIcon(ChevronDown, { size: 14 }));
        toggle.setAttribute("aria-expanded", String(open));
      };
      update(); article.append(toggle);
    }
    if (selected.path) {
      const sourceRow = el("div", "coco-result-source"); sourceRow.append(el("span", "coco-muted", selected.path));
      if (this.actions.openFile) sourceRow.append(toolbarButton("Open current file", ArrowUpRight, () => {
        void this.actions.openFile!(selected.path!).catch(() => this.notice("The source file could not be opened. The saved report remains available here."));
      }));
      article.append(sourceRow);
    }
    if (this.error) article.append(el("p", "coco-error", "Could not refresh saved results. Showing the last loaded output."));
    section.append(article); return section;
  }
  private timeline(work: CocoWork, snapshot: DetailSnapshot): HTMLElement {
    const section = el("section", "coco-detail-section coco-progress-timeline"); section.setAttribute("aria-label", "Progress timeline");
    const head = el("header", "coco-detail-section-heading"); head.append(el("h2", "", "Progress timeline")); section.append(head);
    const events: TimelineEvent[] = [...work.timeline, ...this.results.filter(result => result.source !== "message").map(result => ({ at: result.at, text: result.title, result, revision: result.revision }))].sort((a,b) => a.at - b.at);
    if (!events.length) { section.append(el("p", "coco-muted", "No progress events yet.")); return section; }
    const count = el("span", "coco-muted", `${events.length} ${events.length === 1 ? "event" : "events"}`); head.append(count);
    let day = "", list: HTMLOListElement | undefined;
    for (let index = 0; index < events.length; index++) {
      const event = events[index]!, key = dayKey(event.at, snapshot.settings.timezone);
      if (key !== day) {
        day = key; section.append(el("h3", "coco-timeline-day", `${date(event.at, snapshot.settings.timezone)} · ${snapshot.settings.timezone}`));
        list = el("ol", "coco-progress-events"); section.append(list);
      }
      const item = el("li", `coco-progress-event${event.status ? ` is-${event.status}` : ""}${index === events.length - 1 ? " is-latest" : ""}`);
      const time = el("time", "coco-progress-time", clock(event.at, snapshot.settings.timezone)); time.dateTime = new Date(event.at).toISOString();
      const node = el("span", "coco-progress-node"); node.setAttribute("aria-hidden", "true");
      const icon = event.result ? FileText : event.status === "completed" ? Check : event.status === "waiting" ? Pause : event.status === "recovering" ? RotateCcw : event.status === "to_decide" ? CircleHelp : event.status === "cancelled" ? X : undefined;
      if (icon) node.append(createLucideIcon(icon, { size: 12 }));
      const copy = el("div", "coco-progress-copy");
      copy.append(el("div", "coco-progress-title", event.result ? "Report saved" : event.status ? statusTitles[event.status] : index === 0 && event.at === work.createdAt ? "Plan saved" : "Progress update"));
      if (event.result) {
        const result = event.result;
        const link = button(result.title, () => { this.selected.set(work.id, result.id); this.expanded.add(result.id); this.paint(); this.root.querySelector<HTMLElement>(`#coco-result-${result.id}`)?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); });
        link.classList.add("coco-result-timeline-link"); link.prepend(createLucideIcon(FileText, { size: 13 })); copy.append(link);
      } else if (event.text.length > 500) {
        const key = `${work.id}:${event.at}:${index}`, details = el("details", "coco-progress-more"); details.open = this.timelineExpanded.has(key);
        details.append(el("summary", "", "Read event details"), el("p", "coco-prose", event.text));
        details.ontoggle = () => { if (!this.root.contains(details)) return; if (details.open) this.timelineExpanded.add(key); else this.timelineExpanded.delete(key); this.actions.layoutChanged(); };
        copy.append(details);
      } else copy.append(el("p", "coco-progress-description coco-prose", event.text));
      if (event.revision !== undefined && event.revision !== work.revision) copy.append(el("small", "coco-muted", `Revision ${event.revision}`));
      item.append(time, node, copy); list!.append(item);
    }
    return section;
  }
  private acceptance(work: CocoWork, snapshot: DetailSnapshot): HTMLElement {
    const details = el("details", "coco-detail-section coco-result-acceptance");
    const verification = [...snapshot.verifications].reverse().find(verification => verification.workId === work.id && verification.revision === work.revision);
    details.open = this.criteriaExpanded.has(work.id) || !!verification && !verification.passed;
    const summary = el("summary"), text = verification ? verification.passed ? "Verified" : "Needs review" : "Pending verification";
    summary.append(el("span", "", "Acceptance criteria"), el("span", `coco-acceptance-status${verification ? verification.passed ? " is-passed" : " is-failed" : ""}`, text));
    const list = el("ul", "coco-result-criteria");
    for (const criterion of work.acceptance) {
      const item = el("li"), check = verification?.checks.find(check => check.criterionId === criterion.id);
      item.append(el("span", "", criterion.description));
      if (check) item.append(el("small", check.passed ? "coco-criterion-passed" : "coco-error", `${check.passed ? "Passed" : "Needs review"} · ${check.evidence}`));
      list.append(item);
    }
    details.append(summary, list);
    if (verification?.summary) details.append(el("p", "coco-prose coco-muted", verification.summary));
    if (!work.acceptance.length) details.append(el("p", "coco-muted", "No acceptance criteria were saved."));
    details.ontoggle = () => { if (!this.root.contains(details)) return; if (details.open) this.criteriaExpanded.add(work.id); else this.criteriaExpanded.delete(work.id); this.actions.layoutChanged(); };
    return details;
  }
}
