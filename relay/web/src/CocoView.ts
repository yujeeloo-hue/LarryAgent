/**
 * CocoView — the relay web console's CoCo workspace (demo: demos/relay-coco).
 *
 * Mac client parity: three-column workspace (154px nav | main content |
 * collapsible right chat panel), Overview budget banner with the client's
 * purple→magenta usage bars, To decide, Rules, and the chat side panel
 * (transcript + inline question/approval cards + zebra prompt queue +
 * borderless composer). Work reports render from the device snapshot;
 * rule Create/Edit stays on the device.
 *
 * Rendering is a full re-render per state change (like the demo), with a
 * render-key guard so the 3s poll doesn't churn identical DOM, plus
 * composer value/caret/focus preservation across re-renders.
 */

import { icon } from "./icons.js";
import { cocoIcon } from "./cocoIcons.js";
import type { CocoController, CocoPage, CocoQueueItem } from "./CocoController.js";
import { isNewReport } from "../../../src/coco/overviewOrder.js";
import { parseMarkdownBlocks, renderMarkdownBlocks } from "./markdown.js";
import type {
  CocoBackgroundTask,
  CocoCadence,
  CocoCommand,
  CocoReport,
  CocoRule,
  CocoRuleRun,
  CocoScope,
  CocoSnapshot,
  CocoWork,
  CocoWorkStatus,
} from "./types.js";

export type CocoViewOptions = {
  device: { name: string; platform: string };
  /** Viewer's remote mode for this device — readonly swaps the composer for a note. */
  readonly: boolean;
  onExit: () => void;
  onToast: (message: string) => void;
  /** Page-head connection badge (the app topbar is hidden on standalone pages). */
  headBadge?: () => HTMLElement;
};

type AttrValue = string | boolean | undefined | ((event: Event) => void);

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "function") node.addEventListener(key.replace(/^on/, ""), value as EventListener);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else if (value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === "string") {
      if (child.startsWith("<svg")) {
        const template = document.createElement("template");
        template.innerHTML = child;
        node.append(template.content);
      } else node.append(document.createTextNode(child));
    } else node.append(child);
  }
  return node;
};

const WORK_STATUS_LABEL: Record<CocoWorkStatus, string> = {
  draft: "Draft",
  queued: "Queued",
  executing: "Executing",
  recovering: "Recovering",
  verifying: "Verifying",
  waiting: "Waiting",
  to_decide: "To decide",
  completed: "Verified",
  cancelled: "Cancelled",
};

const STATE_LABEL: Record<CocoSnapshot["state"], string> = {
  idle: "Idle",
  working: "Working",
  paused: "Paused",
  cooldown: "Cooldown",
  blocked: "Blocked",
  stopping: "Stopping",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Client parity (CocoBudgetView.tokenCount): compact counts, K→k. */
const COMPACT = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const fmtTokens = (value: number): string => COMPACT.format(value).replace("K", "k");

function fmtTime(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return sameDay ? hm : `${MONTHS[d.getMonth()]} ${d.getDate()} · ${hm}`;
}

/** Sort key for a run — chat runs pin to their end time (client ruleRunAt). */
function ruleRunAt(run: CocoRuleRun): number {
  return run.source === "chat" ? run.endedAt ?? run.startedAt : run.startedAt;
}

const VISIBLE_RUNS = 10;
const RUN_STATUS_LABELS: Record<CocoRuleRun["status"], string> = {
  running: "Running", retrying: "Retrying", no_action: "No action needed", planned: "Work planned", failed: "Failed",
};

/** Markdown-ish preview: strip heading/hash/bullets, collapse whitespace. */
function plainPreview(markdown: string): string {
  const text = markdown
    .split("\n")
    .filter((line) => !/^\s{0,3}#{1,6}\s/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function runsDayKey(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(at);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function runsDayLabel(at: number, now: number, timezone: string): string {
  const key = runsDayKey(at, timezone);
  const today = runsDayKey(now, timezone);
  if (key === today) return "Today";
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  if (key === yesterday) return "Yesterday";
  return new Date(at).toLocaleDateString("en-US", {
    timeZone: timezone, month: "short", day: "numeric",
    ...(key.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}),
  });
}

function runsClock(at: number, timezone: string): string {
  return new Date(at).toLocaleTimeString("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

function runsDuration(run: CocoRuleRun): string {
  if (run.endedAt === undefined || run.endedAt < run.startedAt) return "";
  const seconds = Math.round((run.endedAt - run.startedAt) / 1000);
  const value = seconds < 60 ? `${seconds}s`
    : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
  return `${run.status === "failed" ? "Ended after" : "Completed in"} ${value}`;
}


function cadenceLabel(cadence: CocoCadence): string {
  switch (cadence.kind) {
    case "minute": return `every ${cadence.n} min`;
    case "hour": return `hourly at :${String(cadence.minute).padStart(2, "0")}`;
    case "day": return `daily ${cadence.time}`;
    case "week": return `${cadence.weekdays.map((d) => WEEKDAYS[d] ?? d).join(" ")} ${cadence.time}`;
    case "month": return `monthly on ${cadence.day} ${cadence.time}`;
    case "year": return `yearly ${cadence.month}/${cadence.day} ${cadence.time}`;
  }
}

function scopeLabel(scope: CocoScope, workspaces: { id: string; name: string }[]): string {
  if (scope.all) return "All current and future projects";
  const names = scope.workspaceIds
    .map((id) => workspaces.find((w) => w.id === id)?.name ?? id)
    .join(", ");
  const excluded = scope.excludedWorkspaceIds.length > 0
    ? ` (excl. ${scope.excludedWorkspaceIds.map((id) => workspaces.find((w) => w.id === id)?.name ?? id).join(", ")})`
    : "";
  return `${names || "Selected projects"}${excluded}`;
}

export class CocoView {
  private selectedWorkId: string | null = null;
  private referenceWorkId: string | null = null;
  private queueCollapsed = false;
  private expandedReports = new Set<string>();
  private renderKey: string | null = null;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly root: HTMLElement,
    private readonly controller: CocoController,
    private readonly options: CocoViewOptions,
  ) {
    this.unsubscribe = controller.subscribe(() => this.render());
  }

  destroy(): void {
    this.unsubscribe();
    this.root.replaceChildren();
  }

  /** Open a work item (also used by s6 assembly to deep-link a session click). */
  openWork(workId: string | null): void {
    this.selectedWorkId = workId;
    this.referenceWorkId = workId;
    this.render();
  }

  render(): void {
    const snapshot = this.controller.getSnapshot();
    const status = this.controller.getStatus();
    const queue = this.controller.getQueue();
    // Skip DOM churn when nothing the view depends on changed (3s poll).
    const key = JSON.stringify([
      status, this.controller.getError(), this.controller.getPage(),
      this.controller.isChatOpen(), this.controller.isCommandPending(),
      this.controller.getReportsSeenAt(),
      this.selectedWorkId, this.referenceWorkId, this.queueCollapsed,
      snapshot, queue,
    ]);
    if (key === this.renderKey) return;
    this.renderKey = key;

    // Preserve composer input across re-renders (typing while polling).
    const previous = this.root.querySelector<HTMLTextAreaElement>(".coco-composer");
    const composerState = previous
      ? {
          value: previous.value,
          focused: document.activeElement === previous,
          start: previous.selectionStart,
          end: previous.selectionEnd,
        }
      : null;

    const view = h("section", { class: "view" });
    view.append(this.buildHead());
    const frame = h("div", { class: "coco-frame" });
    if (status === "loading") {
      frame.append(this.buildLoading());
    } else if (status === "error" || !snapshot) {
      frame.append(this.buildError());
    } else {
      frame.append(this.buildWorkspace(snapshot, queue));
    }
    view.append(frame);
    this.root.replaceChildren(view);

    if (composerState) {
      const composer = this.root.querySelector<HTMLTextAreaElement>(".coco-composer");
      if (composer) {
        composer.value = composerState.value;
        if (composerState.focused) composer.focus();
        try {
          composer.setSelectionRange(composerState.start, composerState.end);
        } catch { /* detached textarea */ }
      }
    }
    const messages = this.root.querySelector<HTMLElement>(".coco-messages");
    if (messages) messages.scrollTop = messages.scrollHeight;
  }

  // ── head / chrome ────────────────────────────────────────────

  private buildHead(): HTMLElement {
    const back = h("button", { class: "m-back", "aria-label": "Back", onclick: () => this.options.onExit() }, icon("back", 16));
    const pill = h("span", { class: "count-pill" }, STATE_LABEL[this.controller.getSnapshot()?.state ?? "idle"] ?? "Idle");
    const refresh = h(
      "button",
      // `head-refresh` lets the ≤768px chrome collapse it to the icon-only
      // 44×44 box every other standalone head uses.
      { class: "ghost-btn head-refresh", onclick: () => void this.controller.refresh() },
      icon("refresh", 13),
      h("span", { class: "btn-label" }, "Refresh"),
    );
    return h("div", { class: "view-head" },
      back,
      cocoIcon("logo"),
      h("h1", {}, "CoCo"),
      h("span", { class: "ctx" }, `${this.options.device.name} · ${this.options.device.platform}`),
      pill,
      h("span", { class: "spacer" }),
      this.options.headBadge?.() ?? null,
      refresh,
    );
  }

  private buildLoading(): HTMLElement {
    return h("div", { class: "coco-offline" },
      h("span", { class: "mini-spin" }),
      h("span", {}, "Loading CoCo from this device…"),
    );
  }

  private buildError(): HTMLElement {
    const retry = h("button", { class: "ghost-btn", onclick: () => void this.controller.refresh() }, icon("refresh", 13), "Retry");
    return h("div", { class: "coco-offline" },
      h("strong", {}, "Couldn't load CoCo"),
      h("span", {}, this.controller.getError() ?? "The device is offline."),
      retry,
    );
  }

  // ── workspace ────────────────────────────────────────────────

  private buildWorkspace(snapshot: CocoSnapshot, queue: CocoQueueItem[]): HTMLElement {
    const ws = h("div", { class: `coco-workspace${this.controller.isChatOpen() ? " is-chat-open" : ""}` });

    const nav = h("nav", { class: "coco-nav", "aria-label": "CoCo navigation" });
    const chatBtn = h("button", {
      class: `coco-nav-item${this.controller.isChatOpen() ? " active" : ""}`,
      "aria-expanded": String(this.controller.isChatOpen()),
      onclick: () => this.controller.toggleChat(),
    }, cocoIcon("chat", "ico"), h("span", {}, "Chat"));
    nav.append(chatBtn);
    nav.append(h("div", { class: "coco-group-label" }, "Work"));
    const navItem = (id: CocoPage, label: string, artwork: string) =>
      h("button", {
        class: `coco-nav-item${this.controller.getPage() === id && !this.selectedWorkId ? " active" : ""}`,
        onclick: () => {
          this.selectedWorkId = null;
          this.controller.setPage(id);
          this.render();
        },
      }, cocoIcon(artwork, "ico"), h("span", {}, label));
    nav.append(navItem("overview", "Overview", "overview"), navItem("to-decide", "To decide", "attention"), navItem("reports", "Reports", "reports"));
    nav.append(h("div", { class: "coco-group-label" }, "Automation"));
    nav.append(navItem("rules", "Rules", "rules"));

    const main = h("div", { class: "coco-main" });
    const selected = this.selectedWorkId
      ? snapshot.work.find((w) => w.id === this.selectedWorkId) ?? null
      : null;
    if (selected) this.renderWorkDetail(main, snapshot, selected);
    else if (this.controller.getPage() === "to-decide") this.renderToDecide(main, snapshot);
    else if (this.controller.getPage() === "rules") this.renderRules(main, snapshot);
    else if (this.controller.getPage() === "reports") this.renderReports(main, snapshot);
    else this.renderOverview(main, snapshot);

    ws.append(nav, h("div", { class: "coco-main-pane" }, main));
    if (this.controller.isChatOpen()) ws.append(this.buildChatPanel(snapshot, queue));
    return ws;
  }

  // ── shared pieces ────────────────────────────────────────────

  private workspaceName(snapshot: CocoSnapshot, id: string): string {
    return snapshot.workspaces.find((w) => w.id === id)?.name ?? id;
  }

  private workRow(snapshot: CocoSnapshot, work: CocoWork): HTMLElement {
    return h("button", {
      class: "coco-work-row",
      type: "button",
      onclick: () => this.openWork(work.id),
    },
      h("div", {},
        h("strong", {}, work.title),
        h("small", { class: "coco-muted" }, `${this.workspaceName(snapshot, work.workspaceId)} project`),
      ),
      h("span", { class: `coco-status ${work.status}` }, WORK_STATUS_LABEL[work.status]),
    );
  }

  private budgetRow(label: string, used: number, cap: number): HTMLElement {
    const pct = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
    const fill = h("i");
    fill.style.width = `${pct.toFixed(1)}%`;
    return h("div", { class: "coco-budget-row" },
      h("span", { class: "coco-budget-label" }, label),
      h("span", { class: "coco-budget-bar" }, fill),
      h("span", { class: "coco-budget-percent" }, `${pct.toFixed(1)}%`),
      h("span", { class: "coco-budget-detail" }, `${fmtTokens(used)} / ${fmtTokens(cap)} tokens`),
    );
  }

  private cmd(command: CocoCommand): void {
    void this.controller.command(command).then((result) => {
      if (!result.ok && result.error) this.options.onToast(result.error);
    });
  }

  // ── Overview ─────────────────────────────────────────────────

  private renderOverview(main: HTMLElement, snapshot: CocoSnapshot): void {
    main.append(h("h1", {}, "Overview"));

    const runtime = h("div", { class: "coco-runtime" });
    runtime.append(h("div", { class: "coco-runtime-heading" },
      cocoIcon("logo"),
      h("strong", {}, STATE_LABEL[snapshot.state]),
    ));
    const sub = snapshot.state === "blocked" && snapshot.error
      ? snapshot.error
      : "One collaborator. A clear plan. Verified outcomes.";
    runtime.append(h("p", { class: "sub" }, sub));

    const budget = h("div", { class: "coco-budget" });
    budget.append(h("h3", { class: "coco-budget-heading" },
      `Token usage${snapshot.budget.estimated ? " · estimated" : ""}`));
    budget.append(this.budgetRow("This hour", snapshot.budget.hourly, snapshot.settings.hourlyTokens));
    budget.append(this.budgetRow("Today", snapshot.budget.daily, snapshot.settings.dailyTokens));
    const goal = h("button", {
      class: "coco-button primary",
      onclick: () => {
        this.controller.toggleChat(true);
        window.setTimeout(() => this.root.querySelector<HTMLTextAreaElement>(".coco-composer")?.focus(), 60);
      },
    }, icon("target", 14), "Give CoCo a goal");
    const reset = h("button", {
      class: "coco-button",
      disabled: this.options.readonly || this.controller.isCommandPending(),
      onclick: () => this.cmd({ type: "budget", action: "reset" }),
    }, "Reset budget");
    budget.append(h("div", { class: "coco-actions" }, goal, reset));
    runtime.append(budget);
    main.append(runtime);

    const moving = snapshot.work.filter((w) => ["executing", "verifying", "recovering"].includes(w.status));
    const upNext = snapshot.work.filter((w) => ["queued", "waiting"].includes(w.status));
    if (moving.length > 0 || upNext.length > 0) {
      const flow = h("section", { class: "coco-section" });
      flow.append(h("div", { class: "coco-flow-head" },
        h("h3", {}, "Moving forward"),
        h("small", {}, `${moving.length} in progress`),
      ));
      for (const w of moving) flow.append(this.workRow(snapshot, w));
      if (upNext.length > 0) {
        flow.append(h("div", { class: "coco-flow-group-head" },
          h("h4", {}, "Up next"),
          h("small", {}, `${upNext.length} items`),
        ));
        for (const w of upNext) flow.append(this.workRow(snapshot, w));
      }
      const nextRule = [...snapshot.rules]
        .filter((r) => r.enabled)
        .sort((a, b) => a.nextRunAt - b.nextRunAt)[0];
      if (nextRule && nextRule.nextRunAt > 0) {
        flow.append(h("button", {
          class: "coco-work-row",
          type: "button",
          onclick: () => this.controller.setPage("rules"),
        },
          h("div", {},
            h("strong", {}, nextRule.name),
            h("small", { class: "coco-muted" },
              `${nextRule.mode === "inspection" ? "Inspection" : "Fixed"} · ${cadenceLabel(nextRule.cadence)}`),
          ),
          h("span", { class: "coco-status" }, fmtTime(nextRule.nextRunAt)),
        ));
      }
      main.append(flow);
    }

    const decide = snapshot.work.filter((w) => w.status === "to_decide");
    if (decide.length > 0) {
      const s = h("section", { class: "coco-section" });
      s.append(h("h3", {}, "To decide"));
      for (const w of decide) s.append(this.workRow(snapshot, w));
      main.append(s);
    }

    const reports = [...snapshot.reports].sort((a, b) => b.at - a.at);
    const report: CocoReport | undefined = reports[0];
    if (report) {
      // Client-parity markup (CocoView.ts report card): timezone-aware date
      // column, kicker/copy, accent arrow. Open the reports from this snapshot.
      const timezone = snapshot.settings.timezone;
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "short", day: "numeric" }).formatToParts(report.at);
      const fullDate = new Intl.DateTimeFormat("en-US", { timeZone: timezone, dateStyle: "long" }).format(report.at);
      const date = h("time", { class: "coco-latest-report-date" });
      date.dateTime = new Date(report.at).toISOString();
      date.setAttribute("aria-label", fullDate);
      date.append(
        h("span", { class: "coco-latest-report-month" }, parts.find((part) => part.type === "month")?.value.toUpperCase() ?? ""),
        h("span", { class: "coco-latest-report-day" }, parts.find((part) => part.type === "day")?.value ?? ""),
      );
      // Client parity: the accent corner marks an unopened report only, and
      // expires after NEW_REPORT_MS so a week-old report is never "new".
      const reportNew = isNewReport(report.at, this.controller.getReportsSeenAt(), Date.now());
      main.append(h("button", {
        class: "coco-section coco-latest-report",
        type: "button",
        "aria-label": `Read the daily work report for ${fullDate}${reportNew ? ", unread" : ""}`,
        onclick: () => {
          this.selectedWorkId = null;
          this.controller.setPage("reports");
        },
      },
        reportNew ? h("span", { class: "coco-latest-report-corner", "aria-hidden": "true" }) : null,
        date,
        h("span", { class: "coco-latest-report-copy" },
          h("span", { class: "coco-latest-report-kicker" }, "Latest report"),
          h("span", { class: "coco-latest-report-title" }, report.title),
        ),
        h("span", { class: "coco-latest-report-arrow" }, icon("chevronRight", 16)),
      ));
    }

    main.append(this.recentRunsView(snapshot));
  }

  /** Overview timeline — client CocoRecentRunsView parity (plain-text detail). */
  private recentRunsView(snapshot: CocoSnapshot): HTMLElement {
    const section = h("section", { class: "coco-section coco-runs" });
    const runs = [...(snapshot.ruleRuns ?? [])].sort((a, b) => ruleRunAt(b) - ruleRunAt(a));
    const header = h("div", { class: "coco-runs-head" });
    const meta = h("span", { class: "coco-runs-meta" });
    header.append(h("h3", {}, "Recent runs"));
    const current = runs.filter((run) => run.status === "running" || run.status === "retrying");
    if (current.length) meta.append(h("span", { class: "coco-runs-active" }, `${current.length} in progress`));
    if (runs.length) meta.append(h("span", {}, `${runs.length} ${runs.length === 1 ? "run" : "runs"}`));
    header.append(meta);
    section.append(header);
    if (!runs.length) {
      section.append(h("p", { class: "coco-muted coco-runs-empty" }, "Rule activity, summaries and task acceptance will appear here."));
      return section;
    }
    const feed = h("div", { class: "coco-runs-feed" });
    section.append(feed);
    const now = Date.now();
    const timezone = snapshot.settings.timezone;
    const visible = runs.slice(0, VISIBLE_RUNS);
    if (current.length) feed.append(this.runsGroup("In progress", current.filter((r) => visible.includes(r)), timezone, now, true));
    const days = new Map<string, CocoRuleRun[]>();
    for (const run of visible.filter((r) => !(r.status === "running" || r.status === "retrying"))) {
      const key = runsDayKey(ruleRunAt(run), timezone);
      const list = days.get(key) ?? [];
      list.push(run);
      days.set(key, list);
    }
    for (const group of days.values()) {
      feed.append(this.runsGroup(runsDayLabel(ruleRunAt(group[0]!), now, timezone), group, timezone, now, false));
    }
    return section;
  }

  private runsGroup(label: string, runs: CocoRuleRun[], timezone: string, now: number, activeGroup: boolean): HTMLElement {
    const group = h("div", { class: "coco-runs-group" });
    const day = h("h4", { class: "coco-runs-day" });
    const marker = h("span", { class: "coco-runs-day-marker", "aria-hidden": "true" }, icon(activeGroup ? "hourglass" : "calendarDays", 14));
    day.append(marker, h("span", { class: "coco-runs-day-label" }, label));
    group.append(day);
    const timeline = h("div", { class: "coco-runs-timeline" });
    for (const run of runs) timeline.append(this.runRow(run, timezone, now));
    group.append(timeline);
    return group;
  }

  private runRow(run: CocoRuleRun, timezone: string, now: number): HTMLElement {
    const item = h("details", { class: `coco-run run-${run.status}` }) as HTMLDetailsElement;
    item.dataset.runId = run.id;
    const at = ruleRunAt(run);
    const chat = run.source === "chat";
    const time = h("time", { class: "coco-run-time" }, runsClock(at, timezone));
    time.dateTime = new Date(at).toISOString();
    const head = h("span", { class: "coco-run-head" },
      h("strong", { class: "coco-run-title" }, run.ruleName),
      h("span", { class: "coco-run-status" }, chat && run.endedAt !== undefined ? "Completed" : RUN_STATUS_LABELS[run.status]),
    );
    const metadata = [runsDuration(run), run.attempts > 1 ? `${run.attempts} attempts` : ""].filter(Boolean);
    const copy = h("span", { class: "coco-run-copy" }, head);
    if (metadata.length) copy.append(h("span", { class: "coco-run-meta" }, metadata.join(" · ")));
    const fallback = chat
      ? run.status === "running" ? "CoCo is working on this request…" : "Work planned from your chat request."
      : run.status === "running" ? "CoCo is reviewing this rule…"
        : run.status === "retrying" ? "This run will retry automatically."
          : run.status === "failed" ? "This run could not be completed. Expand to review the error."
            : run.status === "planned" ? "Work has been planned for this rule." : "No new work was needed.";
    copy.append(h("span", { class: "coco-run-preview" }, run.summary ? plainPreview(run.summary) || fallback : fallback));
    item.append(h("summary", { class: "coco-run-trigger" },
      time,
      h("span", { class: "coco-run-dot", "aria-hidden": "true" }),
      copy,
      icon("chevronRight", 13),
    ));
    const detail = h("div", { class: "coco-run-detail" });
    detail.append(
      h("div", { class: "coco-run-detail-block" },
        h("h4", { class: "coco-run-label" }, "Summary"),
        h("p", { class: "coco-run-summary" }, run.summary ? plainPreview(run.summary) || fallback : fallback),
      ),
    );
    if (run.error && (run.status === "failed" || run.status === "retrying")) {
      detail.append(h("div", { class: "coco-run-detail-block" },
        h("h4", { class: "coco-run-label" }, "Last attempt"),
        h("p", { class: "coco-run-error" }, run.error),
      ));
    }
    item.append(detail);
    void now;
    return item;
  }

  // ── To decide ────────────────────────────────────────────────

  private renderToDecide(main: HTMLElement, snapshot: CocoSnapshot): void {
    main.append(h("h1", {}, "To decide"));
    const s = h("section", { class: "coco-section" });
    s.append(h("h3", {}, "Waiting for your decision"));
    const decide = snapshot.work.filter((w) => w.status === "to_decide");
    if (decide.length === 0) s.append(h("p", { class: "coco-muted" }, "Nothing needs your decision right now."));
    for (const w of decide) s.append(this.workRow(snapshot, w));
    main.append(s);
  }

  // ── Rules ────────────────────────────────────────────────────

  private renderRules(main: HTMLElement, snapshot: CocoSnapshot): void {
    main.append(h("h1", {}, "Automation rules"));
    // Decision #8: the rule editor lives on the device — only the supported
    // actions render (Enable/Pause, Run now, Delete); Create/Edit are hidden.
    if (snapshot.rules.length === 0) {
      main.append(h("section", { class: "coco-section" },
        h("p", { class: "coco-muted" }, "No automation rules on this device yet. CoCo can create rules to follow your goals — create and edit them in CoCo on the Mac client.")));
    }
    for (const rule of snapshot.rules) main.append(this.ruleCard(snapshot, rule));
  }

  private ruleCard(snapshot: CocoSnapshot, rule: CocoRule): HTMLElement {
    const card = h("section", { class: "coco-section coco-rule-card" });
    card.append(h("h3", {}, rule.name));
    card.append(h("p", {}, rule.objective));
    card.append(h("small", { class: "coco-muted" },
      `${rule.mode === "inspection" ? "Inspect" : "Fixed"} · ${cadenceLabel(rule.cadence)} · ${rule.enabled ? "Enabled" : "Paused"}${rule.confirmed ? "" : " · unconfirmed"}`));
    card.append(h("p", { class: "meta" },
      `Scope: ${scopeLabel(rule.scope, snapshot.workspaces)}. Access: ${rule.fullPermissions ? "Full permissions" : "Standard"}.`));
    if (rule.origin === "coco") card.append(h("small", { class: "coco-muted" }, "Created by CoCo to follow a goal"));

    const disabled = this.options.readonly || this.controller.isCommandPending();
    card.append(h("div", { class: "coco-actions" },
      h("button", {
        class: "coco-button",
        disabled,
        onclick: () => this.cmd({ type: "rule", action: "toggle", id: rule.id }),
      }, rule.enabled ? "Pause" : "Enable"),
      h("button", {
        class: "coco-button",
        disabled,
        onclick: () => this.cmd({ type: "rule", action: "run", id: rule.id }),
      }, "Run now"),
      h("button", {
        class: "coco-button action-danger",
        disabled,
        onclick: () => {
          if (!window.confirm(`Delete the rule “${rule.name}” on this device?`)) return;
          this.cmd({ type: "rule", action: "delete", id: rule.id });
        },
      }, "Delete"),
    ));
    return card;
  }

  // ── Work detail ──────────────────────────────────────────────

  private renderWorkDetail(main: HTMLElement, snapshot: CocoSnapshot, work: CocoWork): void {
    main.append(h("header", { class: "coco-work-detail-head" },
      h("h1", {}, work.title),
      h("span", { class: `coco-status ${work.status}` }, WORK_STATUS_LABEL[work.status]),
    ));
    main.append(h("p", { class: "coco-muted coco-work-detail-meta" },
      `${this.workspaceName(snapshot, work.workspaceId)} · updated ${fmtTime(work.updatedAt)} · priority ${work.priority}`));
    main.append(h("p", { class: "coco-prose" }, work.objective));

    const disabled = this.options.readonly || this.controller.isCommandPending();
    const actions = h("div", { class: "coco-actions" });
    if (work.status === "to_decide") {
      actions.append(
        h("button", {
          class: "coco-button primary",
          disabled,
          onclick: () => this.cmd({ type: "work", id: work.id, action: "resume" }),
        }, "Resume"),
        h("button", {
          class: "coco-button",
          disabled,
          onclick: () => this.cmd({ type: "work", id: work.id, action: "priority", priority: 1 }),
        }, "Prioritize"),
        h("button", {
          class: "coco-button",
          disabled,
          onclick: () => this.cmd({ type: "work", id: work.id, action: "cancel" }),
        }, "Cancel work"),
      );
    } else if (["queued", "waiting", "executing", "verifying", "recovering"].includes(work.status)) {
      actions.append(
        h("button", {
          class: "coco-button",
          disabled,
          onclick: () => this.cmd({ type: "work", id: work.id, action: "pause" }),
        }, "Pause"),
        h("button", {
          class: "coco-button",
          disabled,
          onclick: () => this.cmd({ type: "work", id: work.id, action: "priority", priority: 1 }),
        }, "Prioritize"),
        h("button", {
          class: "coco-button",
          disabled,
          onclick: () => this.cmd({ type: "work", id: work.id, action: "cancel" }),
        }, "Cancel work"),
      );
    }
    if (actions.childElementCount > 0) main.append(actions);

    if (work.status === "to_decide") {
      const prompt = work.decisionPrompt;
      const card = h("section", { class: "coco-section" });
      card.append(h("h3", {}, "Your decision"));
      card.append(h("p", { class: "coco-prose" },
        prompt?.question ?? work.decision ?? "Your decision is needed."));
      const choices = h("div", { class: "coco-actions" });
      const options = prompt?.options?.length
        ? prompt.options
        : ["Continue as planned", "Pause this work", "Cancel this work"];
      for (const option of options) {
        choices.append(h("button", {
          class: "coco-button",
          disabled,
          onclick: () => this.cmd({ type: "work", id: work.id, action: "resume", answer: option }),
        }, option));
      }
      card.append(choices);
      if (this.options.readonly) card.append(h("p", { class: "coco-muted" }, "Read-only mode: decisions can only be made on the device."));
      main.append(card);
    }
  }

  // ── Reports ──────────────────────────────────────────────────

  private renderReports(main: HTMLElement, snapshot: CocoSnapshot): void {
    main.append(h("h1", {}, "Work reports"));
    const reports = [...snapshot.reports].sort((a, b) => b.at - a.at);
    if (!reports.length) {
      main.append(h("p", { class: "coco-muted" }, "Your consolidated daily reports will appear here."));
    }
    for (const report of reports) {
      const card = h("section", { class: "coco-section coco-report" });
      const date = h("time", { class: "coco-muted" }, new Intl.DateTimeFormat("en-US", {
        timeZone: snapshot.settings.timezone, dateStyle: "long", timeStyle: "short",
      }).format(report.at));
      date.dateTime = new Date(report.at).toISOString();
      const download = h("button", {
        class: "coco-button coco-report-export", type: "button",
        onclick: () => {
          const url = URL.createObjectURL(new Blob([report.markdown], { type: "text/markdown" }));
          const link = h("a", { href: url, download: `coco-report-${report.at}.md` });
          link.click();
          window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        },
      }, icon("download", 14), "Export Markdown");
      const body = h("div", { class: "coco-prose coco-report-body" });
      renderMarkdownBlocks(parseMarkdownBlocks(report.markdown), body);
      card.append(h("header", { class: "coco-report-heading" },
        h("div", {}, h("h3", {}, report.title), date), download), body);
      const works = [...new Set(report.workIds)].flatMap(id => {
        const work = snapshot.work.find(item => item.id === id);
        return work ? [work] : [];
      });
      if (works.length) {
        const related = h("details", { class: "coco-report-related", open: this.expandedReports.has(report.id) });
        related.addEventListener("toggle", () => {
          if (!this.root.contains(related)) return;
          if (related.open) this.expandedReports.add(report.id);
          else this.expandedReports.delete(report.id);
        });
        related.append(h("summary", {}, `Related work (${works.length})`));
        for (const work of works) related.append(this.workRow(snapshot, work));
        card.append(related);
      }
      main.append(card);
    }
  }

  // ── Chat panel ───────────────────────────────────────────────

  private buildChatPanel(snapshot: CocoSnapshot, queue: CocoQueueItem[]): HTMLElement {
    const card = h("aside", { class: "coco-chat", "aria-label": "CoCo chat" });
    // Phone tier: the panel becomes a full-bleed sheet, so it carries its own
    // 44px header with the collapse control (desktop keeps the floating
    // panel-corner button and hides this bar).
    card.append(h("div", { class: "coco-chat-sheet-head" },
      cocoIcon("chat", "ico"),
      h("strong", {}, "Chat"),
      h("span", { class: "spacer" }),
      h("button", {
        class: "coco-sheet-close",
        "aria-label": "Collapse chat",
        title: "Collapse chat",
        onclick: () => this.controller.toggleChat(false),
      }, icon("chevronDown", 18)),
    ));
    card.append(h("button", {
      class: "coco-chat-collapse",
      "aria-label": "Collapse chat",
      title: "Collapse chat",
      onclick: () => this.controller.toggleChat(false),
    }, icon("panelRight", 14)));

    // Reference — the work the conversation is anchored to.
    const reference = h("div", { class: "coco-reference" });
    const ref = this.referenceWorkId
      ? snapshot.work.find((w) => w.id === this.referenceWorkId) ?? null
      : null;
    if (ref) {
      reference.append(
        h("div", { class: "coco-reference-heading" },
          h("span", {}, "Discussing"),
          h("button", {
            class: "coco-icon-btn",
            "aria-label": "Remove task context",
            onclick: () => {
              this.referenceWorkId = null;
              this.render();
            },
          }, icon("x", 12)),
        ),
        h("strong", {}, ref.title),
        h("small", {}, `${this.workspaceName(snapshot, ref.workspaceId)} · ${WORK_STATUS_LABEL[ref.status]}`),
      );
    } else {
      reference.setAttribute("hidden", "");
    }
    card.append(reference);

    // Use the same Markdown pipeline as Relay sessions and work reports.
    const msgs = h("div", { class: "coco-messages", role: "log" });
    for (const m of snapshot.messages) {
      if (m.role === "user") {
        msgs.append(h("div", { class: "conversation-msg conversation-msg-user" },
          h("div", { class: "conversation-msg-body" }, m.text)));
      } else {
        const body = h("div", { class: "conversation-msg-body" });
        renderMarkdownBlocks(parseMarkdownBlocks(m.text), body);
        msgs.append(h("div", { class: "conversation-msg conversation-msg-assistant" }, body));
      }
    }

    // Background task check cards.
    const tasks = [...(snapshot.backgroundTasks ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3);
    for (const task of tasks) msgs.append(this.backgroundTaskCard(snapshot, task));

    // Inline ask / tool-approval cards.
    if (snapshot.chat?.question) msgs.append(this.questionCard(snapshot.chat.question));
    if (snapshot.chat?.approval) msgs.append(this.approvalCard(snapshot.chat.approval));
    card.append(msgs);

    // Activity line (working only — idle shows nothing).
    const activity = h("div", { class: "coco-chat-activity" });
    if (this.controller.isWorking()) {
      activity.append(
        h("span", { class: "mini-spin" }),
        h("span", {}, `Working${snapshot.chat?.status && snapshot.chat.status !== "idle" ? ` — ${snapshot.chat.status}` : ""}`),
      );
    }
    card.append(activity);

    // Footer: queue + composer.
    const footer = h("div", { class: "coco-chat-footer" });
    if (queue.length > 0) footer.append(this.queueBlock(queue));
    footer.append(this.options.readonly ? this.readonlyNote() : this.composerBlock());
    card.append(footer);
    return card;
  }

  private backgroundTaskCard(snapshot: CocoSnapshot, task: CocoBackgroundTask): HTMLElement {
    const running = task.status === "running";
    const card = h("div", { class: "coco-bg-task" });
    const head = h("div", { class: "row" });
    if (running) head.append(h("span", { class: "mini-spin" }));
    head.append(h("span", { class: "t" }, task.title));
    head.append(h("span", { class: `coco-status ${running ? "executing" : task.status === "completed" ? "completed" : ""}` },
      running ? "Running" : task.status.charAt(0).toUpperCase() + task.status.slice(1)));
    card.append(head);
    const detail = [task.progress, task.summary].filter(Boolean).join(" · ");
    if (detail) card.append(h("div", { class: "d" }, detail));
    if (task.workId) {
      card.addEventListener("click", () => {
        this.referenceWorkId = task.workId ?? null;
        this.render();
      });
    }
    return card;
  }

  private questionCard(question: {
    requestId: string;
    question: string;
    options: string[];
    allowCustom: boolean;
    allowMultiple: boolean;
  }): HTMLElement {
    const card = h("div", { class: "coco-chat-prompt" });
    card.append(h("strong", {}, question.question));
    for (const option of question.options) {
      card.append(h("button", {
        class: "coco-button",
        disabled: this.options.readonly,
        onclick: () => this.cmd({
          type: "chatControl",
          action: "answer",
          requestId: question.requestId,
          selected: option,
          custom: false,
        }),
      }, option));
    }
    card.append(h("small", { class: "coco-muted" },
      this.options.readonly
        ? "Read-only: answer on the device."
        : question.allowCustom ? "You can also reply in the message box below." : ""));
    return card;
  }

  private approvalCard(approval: {
    requestId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): HTMLElement {
    const card = h("div", { class: "coco-chat-prompt" });
    card.append(h("strong", {}, `Approve ${approval.toolName}`));
    let preview = "";
    try {
      preview = JSON.stringify(approval.arguments, null, 2);
    } catch {
      preview = String(approval.arguments);
    }
    if (preview.length > 400) preview = `${preview.slice(0, 400)}…`;
    card.append(h("p", { class: "coco-prose" }, preview));
    const disabled = this.options.readonly;
    card.append(
      h("button", {
        class: "coco-button primary",
        disabled,
        onclick: () => this.cmd({ type: "chatControl", action: "approval", requestId: approval.requestId, approved: true }),
      }, "Approve"),
      h("button", {
        class: "coco-button",
        disabled,
        onclick: () => this.cmd({ type: "chatControl", action: "approval", requestId: approval.requestId, approved: false }),
      }, "Deny"),
    );
    return card;
  }

  private queueBlock(queue: CocoQueueItem[]): HTMLElement {
    const working = this.controller.isWorking();
    const block = h("div", { class: "coco-prompt-queue" });
    const toggle = h("button", {
      class: "coco-queue-toggle",
      "aria-expanded": String(!this.queueCollapsed),
      onclick: () => {
        this.queueCollapsed = !this.queueCollapsed;
        this.render();
      },
    },
      icon("arrowUpToTop", 11),
      h("span", {}, "Queued"),
      h("span", { class: "coco-queue-count" }, `· ${queue.length}`),
      icon(this.queueCollapsed ? "chevronRight" : "chevronDown", 10),
    );
    block.append(h("div", { class: "coco-queue-head" },
      toggle,
      h("span", { class: "coco-queue-hint" }, working ? "After this turn" : "Ready to send"),
    ));
    if (!this.queueCollapsed) {
      const rows = h("div", { class: "coco-queue-rows" });
      queue.forEach((item, index) => {
        const row = h("div", { class: "coco-queue-row" });
        row.append(h("span", { class: "coco-queue-index" }, String(index + 1)));
        row.append(h("span", { class: "coco-queue-text" }, item.userText));
        if (!this.options.readonly) {
          row.append(
            h("button", {
              class: "coco-queue-action is-insert",
              "aria-label": working ? "Interrupt and send" : "Send now",
              title: working ? "Interrupt & send" : "Send now",
              onclick: () => void this.controller.promotePrompt(item.id).then((r) => {
                if (!r.ok && r.error) this.options.onToast(r.error);
              }),
            }, icon("arrowUpToTop", 12)),
            h("button", {
              class: "coco-queue-action",
              "aria-label": `Remove queued message ${index + 1}`,
              title: "Remove",
              onclick: () => void this.controller.removePrompt(item.id).then((r) => {
                if (!r.ok && r.error) this.options.onToast(r.error);
              }),
            }, icon("x", 12)),
          );
        }
        rows.append(row);
      });
      block.append(rows);
    }
    return block;
  }

  private readonlyNote(): HTMLElement {
    return h("div", { class: "coco-readonly-note" },
      icon("lock", 13),
      h("span", {}, "Read-only remote view — chat and decisions happen on the device."),
    );
  }

  private composerBlock(): HTMLElement {
    // Client parity: one composer, one round send control that swaps its face
    // between send (ArrowUp) and stop (Square) — ComposerSendButtonView look.
    const working = this.controller.isWorking();
    const composer = h("textarea", {
      class: "coco-composer",
      rows: "3",
      placeholder: "Give CoCo a goal, ask a question, or adjust the plan…",
      "aria-label": "Message CoCo",
      title: "Enter to send · Shift+Enter for a new line",
    }) as HTMLTextAreaElement;

    // ── send control (client ComposerSendButtonView structure) ──
    const wrap = h("div", { class: "composer-send-wrap" + (working ? " is-running" : "") });
    const RING_RADIUS = 15.5;
    const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
    const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    ring.setAttribute("class", "context-usage-ring");
    ring.setAttribute("viewBox", "0 0 36 36");
    ring.setAttribute("aria-hidden", "true");
    const track = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    track.setAttribute("class", "context-usage-track");
    track.setAttribute("cx", "18");
    track.setAttribute("cy", "18");
    track.setAttribute("r", String(RING_RADIUS));
    track.setAttribute("fill", "none");
    const progress = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    progress.setAttribute("class", "context-usage-progress");
    progress.setAttribute("cx", "18");
    progress.setAttribute("cy", "18");
    progress.setAttribute("r", String(RING_RADIUS));
    progress.setAttribute("fill", "none");
    progress.setAttribute("stroke-dasharray", String(RING_CIRCUMFERENCE));
    progress.setAttribute("stroke-dashoffset", String(RING_CIRCUMFERENCE));
    progress.setAttribute("stroke-linecap", "round");
    ring.append(track, progress);

    // icon() returns an svg markup string — replaceChildren() only accepts
    // Nodes in real DOMs (linkedom is lenient, Chrome throws), so mount the
    // face via innerHTML from the internal static icon table.
    const stopFace = () => {
      wrap.classList.add("is-running");
      button.classList.add("is-stop");
      button.setAttribute("aria-label", "Stop");
      button.title = "Stop the current turn";
      button.innerHTML = icon("square", 12);
    };
    const sendFace = () => {
      wrap.classList.remove("is-running");
      button.classList.remove("is-stop");
      button.setAttribute("aria-label", "Send");
      button.title = "Send";
      button.innerHTML = icon("arrowUp", 16);
    };
    const button = h("button", { class: "composer-send-btn", type: "button", "aria-label": "Send", title: "Send", disabled: true }) as HTMLButtonElement;
    if (working) stopFace(); else sendFace();
    wrap.append(ring, button);

    const sync = () => {
      const nowWorking = this.controller.isWorking();
      if (nowWorking) stopFace(); else sendFace();
      if (nowWorking) {
        // Stop stays clickable while a turn runs; send re-enables with text.
        button.disabled = false;
      } else {
        button.disabled = !composer.value.trim() || this.controller.isCommandPending();
      }
    };
    composer.addEventListener("input", sync);

    const submit = () => {
      const text = composer.value.trim();
      if (!text) return;
      composer.value = "";
      sync();
      void this.controller.sendChat(text).then((r) => {
        if (!r.ok && r.error) this.options.onToast(r.error);
      });
      window.setTimeout(() => {
        const m = this.root.querySelector<HTMLElement>(".coco-messages");
        if (m) m.scrollTop = m.scrollHeight;
      }, 30);
    };
    button.addEventListener("click", () => {
      if (this.controller.isWorking()) {
        this.cmd({ type: "chatControl", action: "stop" });
        return;
      }
      submit();
    });
    composer.addEventListener("keydown", (event) => {
      const ke = event as KeyboardEvent;
      if (ke.key !== "Enter" || ke.shiftKey || ke.isComposing || ke.keyCode === 229) return;
      event.preventDefault();
      if (!ke.repeat) submit();
    });
    sync();
    return h("div", { class: "coco-compose" }, composer, h("div", { class: "coco-compose-tools" }, wrap));
  }
}
