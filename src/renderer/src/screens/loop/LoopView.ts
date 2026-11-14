import { ChevronDown, Clock, Pencil, Plus, RefreshCw, RotateCcwClock, Trash2 } from "lucide";
import { formatRelativeTime } from "../../navigation/formatRelativeTime.js";
import { createLucideIcon } from "../../ui/icons.js";
import { AppDropdown } from "../../ui/appDropdown.js";
import { EffortSegView } from "../../ui/effortSeg/EffortSegView.js";
import type { LoopCadenceKind, LoopRecordView } from "./loopTypes.js";
import "./loop.css";

/** Daemon status row display model (computed by the controller). */
export type DaemonDisplay = {
  tone: "running" | "stale" | "stopped" | "missing";
  label: string;
  detail: string;
  /** ensure = user-intent start (installs when missing); stop = bootout. */
  action: "ensure" | "stop" | null;
  /** Button copy for `action` ("Install & Enable" / "Start" / "Stop"). */
  actionLabel: string;
};

export type LoopWorkspaceOption = { id: string; name: string };
export type LoopProviderOption = { id: string; name: string; modelId: string };

export type LoopEditorDefaults = {
  workspaceId: string;
  providerId: string;
};

export type LoopCardRenderInput = {
  loops: readonly LoopRecordView[];
  workspaceNames: ReadonlyMap<string, string>;
  /** providerId → "Name · modelId" label (or fallback). */
  providerLabels: ReadonlyMap<string, string>;
  expandedIds: ReadonlySet<string>;
  runsByLoopId: ReadonlyMap<string, LoopRunRecord[]>;
  runsLoading: ReadonlySet<string>;
};

type CollectResult =
  | { ok: true; payload: LoopInputPayload }
  | { ok: false; error: string };

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const RUN_MODES: Array<{ id: "agent" | "plan" | "ask"; label: string }> = [
  { id: "agent", label: "Agent" },
  { id: "plan", label: "Plan" },
  { id: "ask", label: "Ask" },
];
const CADENCE_KIND_OPTIONS: Array<{ id: LoopCadenceKind; label: string }> = [
  { id: "minute", label: "Every N minutes" },
  { id: "hour", label: "Hourly" },
  { id: "day", label: "Daily" },
  { id: "week", label: "Weekly (pick weekdays)" },
  { id: "month", label: "Monthly" },
  { id: "year", label: "Yearly" },
];
const TIME_OF_DAY_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function runStatusLabel(status: LoopRunRecord["status"]): string {
  const label = status.charAt(0).toUpperCase() + status.slice(1);
  return label;
}

/** Loops management screen — daemon status bar, loop cards, inline editor. */
export class LoopView {
  readonly root: HTMLElement;

  private readonly daemonDot: HTMLElement;
  private readonly daemonTitle: HTMLElement;
  private readonly daemonDetail: HTMLElement;
  private readonly daemonActionBtn: HTMLButtonElement;
  private readonly daemonRefreshBtn: HTMLButtonElement;

  private readonly newLoopBtn: HTMLButtonElement;
  private readonly listEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private readonly emptyNewLoopBtn: HTMLButtonElement;

  private readonly editorEl: HTMLElement;
  private readonly editorTitleEl: HTMLElement;
  private readonly editorErrorEl: HTMLElement;
  private readonly nameInput: HTMLInputElement;
  private readonly promptInput: HTMLTextAreaElement;
  private readonly kindSelect: AppDropdown;
  private readonly cadenceExtraEl: HTMLElement;
  private readonly workspaceSelect: AppDropdown;
  private readonly providerSelect: AppDropdown;
  private readonly runModeButtons = new Map<string, HTMLButtonElement>();
  private readonly reasoningSeg: EffortSegView;
  private readonly fullPermissionsToggle: HTMLInputElement;
  private readonly enabledToggle: HTMLInputElement;
  private readonly editorCancelBtn: HTMLButtonElement;
  private readonly editorSaveBtn: HTMLButtonElement;

  /** Editor draft state (kept across kind switches). */
  private cadenceKind: LoopCadenceKind = "day";
  private readonly cadenceDraft = {
    minuteN: "5",
    hourMinute: "0",
    time: "09:00",
    monthDay: "1",
    yearMonth: "1",
    yearDay: "1",
  };
  private readonly weekdaySet = new Set<number>([1]);
  private runMode: "agent" | "plan" | "ask" = "agent";

  /**
   * Expansion state rendered last — cards are rebuilt on every render, so a
   * changed card is built at its previous visual state and flipped after
   * layout to let the CSS transition animate (arrow + collapsible height).
   */
  // Data identity per mounted runs panel — skip DOM refresh when unchanged.
  private runsPanelIdentity = new WeakMap<HTMLElement, unknown>();

  private onNewLoopHandler: (() => void) | undefined;
  private onEditLoopHandler: ((loopId: string) => void) | undefined;
  private onDeleteLoopHandler: ((loopId: string) => void) | undefined;
  private onToggleEnabledHandler:
    | ((loopId: string, enabled: boolean) => void)
    | undefined;
  private onToggleRunsHandler: ((loopId: string) => void) | undefined;
  private onSelectRunSessionHandler: ((sessionId: string) => void) | undefined;
  private onDaemonActionHandler:
    | ((action: "ensure" | "stop") => void)
    | undefined;
  private onDaemonRefreshHandler: (() => void) | undefined;
  private onEditorSubmitHandler: (() => void) | undefined;
  private onEditorCancelHandler: (() => void) | undefined;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "screen loop-screen";

    // --- Header ---
    const header = document.createElement("header");
    header.className = "screen-header";
    const title = document.createElement("h1");
    title.className = "screen-title";
    title.textContent = "Loops";
    const subtitle = document.createElement("p");
    subtitle.className = "screen-subtitle";
    // macOS: launchd daemon keeps loops running while the app is closed.
    // Windows: the resident-tray app process is the scheduler.
    subtitle.textContent =
      window.jellybot?.platform === "win32"
        ? "Schedule agent tasks that run automatically while JellyBot stays in the tray."
        : "Schedule agent tasks that run automatically in the background — even when JellyBot is closed.";
    header.append(title, subtitle);

    // --- Daemon status bar ---
    const daemonBar = document.createElement("div");
    daemonBar.className = "loop-daemon-bar";

    this.daemonDot = document.createElement("span");
    this.daemonDot.className = "loop-daemon-dot";
    this.daemonDot.setAttribute("aria-hidden", "true");

    const daemonCopy = document.createElement("div");
    daemonCopy.className = "loop-daemon-copy";
    this.daemonTitle = document.createElement("span");
    this.daemonTitle.className = "loop-daemon-title";
    this.daemonTitle.textContent = "Scheduler daemon";
    this.daemonDetail = document.createElement("span");
    this.daemonDetail.className = "loop-daemon-detail";
    this.daemonDetail.textContent = "Checking status…";
    daemonCopy.append(this.daemonTitle, this.daemonDetail);

    const daemonActions = document.createElement("div");
    daemonActions.className = "loop-daemon-actions";
    this.daemonActionBtn = document.createElement("button");
    this.daemonActionBtn.type = "button";
    this.daemonActionBtn.className = "setting-btn";
    this.daemonActionBtn.hidden = true;
    this.daemonRefreshBtn = document.createElement("button");
    this.daemonRefreshBtn.type = "button";
    this.daemonRefreshBtn.className = "loop-icon-btn";
    this.daemonRefreshBtn.title = "Refresh daemon status";
    this.daemonRefreshBtn.setAttribute("aria-label", "Refresh daemon status");
    this.daemonRefreshBtn.append(createLucideIcon(RefreshCw, { size: 14 }));
    daemonActions.append(this.daemonActionBtn, this.daemonRefreshBtn);

    daemonBar.append(this.daemonDot, daemonCopy, daemonActions);

    // --- Toolbar ---
    const toolbar = document.createElement("div");
    toolbar.className = "loop-toolbar";
    const toolbarTitle = document.createElement("p");
    toolbarTitle.className = "loop-toolbar-title";
    toolbarTitle.textContent = "Scheduled loops";
    this.newLoopBtn = document.createElement("button");
    this.newLoopBtn.type = "button";
    this.newLoopBtn.className = "setting-btn setting-btn-primary action-primary";
    this.newLoopBtn.append(createLucideIcon(Plus, { size: 14 }));
    const newLoopLabel = document.createElement("span");
    newLoopLabel.textContent = "New Loop";
    this.newLoopBtn.append(newLoopLabel);
    toolbar.append(toolbarTitle, this.newLoopBtn);

    // --- Editor ---
    const editor = this.buildEditor();
    this.editorEl = editor.root;
    this.editorTitleEl = editor.titleEl;
    this.editorErrorEl = editor.errorEl;
    this.nameInput = editor.nameInput;
    this.promptInput = editor.promptInput;
    this.kindSelect = editor.kindSelect;
    this.cadenceExtraEl = editor.cadenceExtraEl;
    this.workspaceSelect = editor.workspaceSelect;
    this.providerSelect = editor.providerSelect;
    this.reasoningSeg = editor.reasoningSeg;
    this.fullPermissionsToggle = editor.fullPermissionsToggle;
    this.enabledToggle = editor.enabledToggle;
    this.editorCancelBtn = editor.cancelBtn;
    this.editorSaveBtn = editor.saveBtn;
    for (const [mode, button] of editor.runModeButtons) {
      this.runModeButtons.set(mode, button);
    }

    // --- List + empty state ---
    this.listEl = document.createElement("div");
    this.listEl.className = "loop-list";

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "loop-empty";
    const emptyIcon = document.createElement("span");
    emptyIcon.className = "loop-empty-icon";
    const emptyArtwork = createLucideIcon(RotateCcwClock, { size: 24 });
    emptyIcon.setAttribute("aria-hidden", "true");
    emptyIcon.append(emptyArtwork);
    const emptyTitle = document.createElement("p");
    emptyTitle.className = "loop-empty-title";
    emptyTitle.textContent = "No loops yet";
    const emptyDesc = document.createElement("p");
    emptyDesc.className = "loop-empty-desc";
    emptyDesc.textContent =
      "Create a loop to run a prompt on a schedule — every few minutes, daily, weekly, or on specific dates. Runs appear as tasks with a Loop badge.";
    this.emptyNewLoopBtn = document.createElement("button");
    this.emptyNewLoopBtn.type = "button";
    this.emptyNewLoopBtn.className = "setting-btn setting-btn-primary action-primary";
    this.emptyNewLoopBtn.append(createLucideIcon(Plus, { size: 14 }));
    const emptyBtnLabel = document.createElement("span");
    emptyBtnLabel.textContent = "New Loop";
    this.emptyNewLoopBtn.append(emptyBtnLabel);
    this.emptyEl.append(emptyIcon, emptyTitle, emptyDesc, this.emptyNewLoopBtn);

    this.root.append(header, daemonBar, toolbar, this.editorEl, this.listEl, this.emptyEl);
    this.renderLoops({
      loops: [],
      workspaceNames: new Map(),
      providerLabels: new Map(),
      expandedIds: new Set(),
      runsByLoopId: new Map(),
      runsLoading: new Set(),
    });
    // Stay blank until the controller's first render (no premature empty state).
    this.emptyEl.hidden = true;
    this.listEl.hidden = true;

    this.wireEvents();
  }

  // ---------------------------------------------------------------- events

  private wireEvents(): void {
    this.newLoopBtn.addEventListener("click", () => this.onNewLoopHandler?.());
    this.emptyNewLoopBtn.addEventListener("click", () =>
      this.onNewLoopHandler?.(),
    );
    this.daemonRefreshBtn.addEventListener("click", () =>
      this.onDaemonRefreshHandler?.(),
    );
    this.daemonActionBtn.addEventListener("click", () => {
      const label = this.daemonActionBtn.dataset.action;
      if (label === "ensure" || label === "stop") {
        this.onDaemonActionHandler?.(label);
      }
    });
    this.editorCancelBtn.addEventListener("click", () =>
      this.onEditorCancelHandler?.(),
    );
    this.editorSaveBtn.addEventListener("click", () =>
      this.onEditorSubmitHandler?.(),
    );
    this.kindSelect.addEventListener("change", () => {
      const value = this.kindSelect.value;
      if (CADENCE_KIND_OPTIONS.some((option) => option.id === value)) {
        this.cadenceKind = value as LoopCadenceKind;
        this.renderCadenceFields();
      }
    });

    this.listEl.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const card = target.closest<HTMLElement>(".loop-card");
      const loopId = card?.dataset.loopId;
      if (!loopId) return;

      const sessionBtn = target.closest<HTMLButtonElement>(".loop-run-session");
      if (sessionBtn) {
        const sessionId = sessionBtn.dataset.sessionId;
        if (sessionId) this.onSelectRunSessionHandler?.(sessionId);
        return;
      }
      if (target.closest(".loop-card-edit")) {
        this.onEditLoopHandler?.(loopId);
        return;
      }
      if (target.closest(".loop-card-delete")) {
        this.onDeleteLoopHandler?.(loopId);
        return;
      }
      if (target.closest(".loop-card-runs-btn")) {
        this.onToggleRunsHandler?.(loopId);
      }
    });

    this.listEl.addEventListener("change", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!target.classList.contains("loop-enable-input")) return;
      const card = target.closest<HTMLElement>(".loop-card");
      const loopId = card?.dataset.loopId;
      if (loopId) this.onToggleEnabledHandler?.(loopId, target.checked);
    });
  }

  onNewLoop(handler: () => void): void {
    this.onNewLoopHandler = handler;
  }

  onEditLoop(handler: (loopId: string) => void): void {
    this.onEditLoopHandler = handler;
  }

  onDeleteLoop(handler: (loopId: string) => void): void {
    this.onDeleteLoopHandler = handler;
  }

  onToggleEnabled(handler: (loopId: string, enabled: boolean) => void): void {
    this.onToggleEnabledHandler = handler;
  }

  onToggleRuns(handler: (loopId: string) => void): void {
    this.onToggleRunsHandler = handler;
  }

  onSelectRunSession(handler: (sessionId: string) => void): void {
    this.onSelectRunSessionHandler = handler;
  }

  onDaemonAction(handler: (action: "ensure" | "stop") => void): void {
    this.onDaemonActionHandler = handler;
  }

  onDaemonRefresh(handler: () => void): void {
    this.onDaemonRefreshHandler = handler;
  }

  onEditorSubmit(handler: () => void): void {
    this.onEditorSubmitHandler = handler;
  }

  onEditorCancel(handler: () => void): void {
    this.onEditorCancelHandler = handler;
  }

  // --------------------------------------------------------------- daemon

  renderDaemon(display: DaemonDisplay | null, busy: boolean): void {
    this.daemonRefreshBtn.disabled = busy;
    this.daemonActionBtn.classList.toggle("action-primary", display?.action === "ensure");
    this.daemonActionBtn.classList.toggle("action-danger", display?.action === "stop");
    this.daemonActionBtn.disabled = busy;
    this.daemonActionBtn.setAttribute("aria-busy", String(busy && !!display?.action));
    if (!display) {
      this.daemonDot.className = "loop-daemon-dot";
      this.daemonTitle.textContent = "Scheduler daemon";
      this.daemonDetail.textContent = busy
        ? "Working…"
        : "Checking status…";
      this.daemonActionBtn.hidden = true;
      return;
    }
    this.daemonDot.className = `loop-daemon-dot is-${display.tone}`;
    this.daemonTitle.textContent = `Scheduler daemon — ${display.label}`;
    this.daemonDetail.textContent = display.detail;
    if (display.action && !busy) {
      this.daemonActionBtn.hidden = false;
      this.daemonActionBtn.dataset.action = display.action;
      this.daemonActionBtn.textContent = display.actionLabel;
    } else {
      this.daemonActionBtn.hidden = true;
    }
  }

  // ---------------------------------------------------------------- cards

  renderLoops(input: LoopCardRenderInput): void {
    // Patch cards in place (keyed by loop id): the expand/collapse CSS
    // transitions live on the persistent card elements, so re-mounting a
    // card mid-animation (e.g. when async runs load) would cancel it.
    const existing = new Map<string, HTMLElement>();
    for (const child of Array.from(this.listEl.children)) {
      if (
        child instanceof HTMLElement &&
        child.classList.contains("loop-card")
      ) {
        const id = child.dataset.loopId;
        if (id) existing.set(id, child);
      }
    }

    const keep = new Set(input.loops.map((loop) => loop.id));
    for (const [id, card] of existing) {
      if (!keep.has(id)) {
        card.remove();
        existing.delete(id);
      }
    }

    input.loops.forEach((loop, index) => {
      const expanded = input.expandedIds.has(loop.id);
      let card = existing.get(loop.id);
      if (!card) {
        card = this.buildLoopCard(loop, input, expanded);
        existing.set(loop.id, card);
      } else {
        this.patchLoopCard(card, loop, input, expanded);
      }
      const current = this.listEl.children.item(index);
      if (current !== card) this.listEl.insertBefore(card, current);
    });

    const showEmpty = input.loops.length === 0 && this.editorEl.hidden;
    this.emptyEl.hidden = !showEmpty;
    this.listEl.hidden = input.loops.length === 0;
  }

  /**
   * Update a reused card in place. The card, collapsible wrappers, and the
   * chevron button are never re-created — their CSS transitions (height
   * reveal, opacity, arrow rotation) depend on element identity.
   */
  private patchLoopCard(
    card: HTMLElement,
    loop: LoopRecordView,
    input: LoopCardRenderInput,
    expanded: boolean,
  ): void {
    card.classList.toggle("is-expanded", expanded);

    const name = card.querySelector<HTMLElement>(".loop-card-name");
    if (name) {
      name.textContent = loop.name;
      name.title = loop.name;
    }

    const meta = card.querySelector<HTMLElement>(".loop-card-meta");
    if (meta) {
      const fresh = this.buildMetaLine(loop, input);
      meta.title = fresh.title;
      meta.replaceChildren(...Array.from(fresh.children));
    }    const enableInput =
      card.querySelector<HTMLInputElement>(".loop-enable-input");
    if (enableInput) {
      enableInput.checked = loop.enabled;
      enableInput.setAttribute("aria-label", `Enable ${loop.name}`);
    }
    const enableLabel = card.querySelector<HTMLElement>(".loop-enable");
    if (enableLabel) {
      enableLabel.title = loop.enabled ? "Disable loop" : "Enable loop";
    }

    const runsBtn = card.querySelector<HTMLButtonElement>(
      ".loop-card-runs-btn",
    );
    if (runsBtn) {
      runsBtn.title = expanded ? "Hide details" : "Show details";
      runsBtn.setAttribute(
        "aria-label",
        `${expanded ? "Hide" : "Show"} details for ${loop.name}`,
      );
      runsBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    }

    const inner = card.querySelector<HTMLElement>(
      ".loop-card-collapsible-inner",
    );
    if (!inner) return;

    // Body (cadence + stats) holds no transition state — rebuild freely.
    const body = inner.querySelector<HTMLElement>(".loop-card-body");
    if (body) {
      body.replaceChildren(...this.buildCardBodyChildren(loop, input));
    }

    // Runs panel: mount on first expand; afterwards stay mounted (also while
    // collapsed, so the collapse animation keeps showing it) and only refresh
    // when the underlying data identity changed.
    let panel = inner.querySelector<HTMLElement>(".loop-card-runs");
    if (!panel) {
      if (!expanded) return;
      const fresh = this.buildRunsPanel(loop.id, input);
      this.runsPanelIdentity.set(fresh, this.runsPanelKey(loop.id, input));
      inner.append(fresh);
      return;
    }
    const identity = this.runsPanelKey(loop.id, input);
    if (this.runsPanelIdentity.get(panel) !== identity) {
      const next = this.buildRunsPanel(loop.id, input);
      this.runsPanelIdentity.set(next, identity);
      panel.replaceWith(next);
    }
  }

  /** Data identity of a runs panel: "loading", a runs-array ref, or "none". */
  private runsPanelKey(
    loopId: string,
    input: LoopCardRenderInput,
  ): unknown {
    if (input.runsLoading.has(loopId)) return "loading";
    return input.runsByLoopId.get(loopId) ?? "none";
  }

  private buildLoopCard(
    loop: LoopRecordView,
    input: LoopCardRenderInput,
    expanded: boolean,
  ): HTMLElement {
    const card = document.createElement("article");
    card.className = "loop-card";
    card.dataset.loopId = loop.id;
    if (expanded) card.classList.add("is-expanded");

    const header = document.createElement("div");
    header.className = "loop-card-header";

    const titles = document.createElement("div");
    titles.className = "loop-card-titles";

    const name = document.createElement("h3");
    name.className = "loop-card-name";
    name.textContent = loop.name;
    name.title = loop.name;
    titles.append(name);

    titles.append(this.buildMetaLine(loop, input));

    const controls = document.createElement("div");
    controls.className = "loop-card-controls";

    const enableLabel = document.createElement("label");
    enableLabel.className = "loop-enable";
    enableLabel.title = loop.enabled ? "Disable loop" : "Enable loop";
    const enableInput = document.createElement("input");
    enableInput.type = "checkbox";
    enableInput.className = "setting-toggle loop-enable-input";
    enableInput.checked = loop.enabled;
    enableInput.setAttribute("aria-label", `Enable ${loop.name}`);
    enableLabel.append(enableInput);

    const runsBtn = document.createElement("button");
    runsBtn.type = "button";
    runsBtn.className = "loop-icon-btn loop-card-runs-btn";
    runsBtn.title = expanded ? "Hide details" : "Show details";
    runsBtn.setAttribute(
      "aria-label",
      `${expanded ? "Hide" : "Show"} details for ${loop.name}`,
    );
    runsBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
    runsBtn.append(createLucideIcon(ChevronDown, { size: 15 }));

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "loop-icon-btn loop-card-edit";
    editBtn.title = "Edit";
    editBtn.setAttribute("aria-label", `Edit ${loop.name}`);
    editBtn.append(createLucideIcon(Pencil, { size: 14 }));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "loop-icon-btn is-danger loop-card-delete";
    deleteBtn.title = "Delete";
    deleteBtn.setAttribute("aria-label", `Delete ${loop.name}`);
    deleteBtn.append(createLucideIcon(Trash2, { size: 14 }));

    controls.append(enableLabel, runsBtn, editBtn, deleteBtn);
    header.append(titles, controls);

    const body = document.createElement("div");
    body.className = "loop-card-body";
    body.append(...this.buildCardBodyChildren(loop, input));

    // Everything below the header divider lives in one collapsible so a
    // single 0fr→1fr grid transition animates the whole reveal.
    const collapsibleInner = document.createElement("div");
    collapsibleInner.className = "loop-card-collapsible-inner";
    collapsibleInner.append(body);
    // Keep the panel mounted while collapsing so the reverse animation
    // still shows it instead of vanishing mid-transition.
    if (expanded) {
      const panel = this.buildRunsPanel(loop.id, input);
      this.runsPanelIdentity.set(panel, this.runsPanelKey(loop.id, input));
      collapsibleInner.append(panel);
    }
    const collapsible = document.createElement("div");
    collapsible.className = "loop-card-collapsible";
    collapsible.append(collapsibleInner);

    card.append(header, collapsible);

    return card;
  }

  /**
   * Single muted meta line under the name: cadence first (a loop's essence),
   * then mode / provider / workspace as quiet dot-separated details. Replaces
   * the old wall of bordered pills.
   */
  private buildMetaLine(
    loop: LoopRecordView,
    input: LoopCardRenderInput,
  ): HTMLElement {
    const meta = document.createElement("p");
    meta.className = "loop-card-meta";
    meta.append(createLucideIcon(Clock, { size: 13 }));

    const parts: string[] = [];
    const cadence = document.createElement("span");
    cadence.className = "loop-card-meta-cadence";
    cadence.textContent = loop.cadenceSummary;
    meta.append(cadence);
    parts.push(loop.cadenceSummary);

    const details = [
      loop.runMode.charAt(0).toUpperCase() + loop.runMode.slice(1),
      loop.providerId === ""
        ? "Default provider"
        : (input.providerLabels.get(loop.providerId) ?? loop.providerId),
      input.workspaceNames.get(loop.workspaceId) ?? "Unknown workspace",
    ];
    for (const detail of details) {
      const sep = document.createElement("span");
      sep.className = "loop-card-meta-sep";
      sep.textContent = "·";
      meta.append(sep);
      const span = document.createElement("span");
      span.textContent = detail;
      meta.append(span);
      parts.push(detail);
    }

    if (!loop.enabled) {
      const pausedPill = document.createElement("span");
      pausedPill.className = "loop-pill is-paused";
      pausedPill.textContent = "Paused";
      meta.append(pausedPill);
      parts.push("Paused");
    }

    meta.title = parts.join(" · ");
    return meta;
  }

  private buildCardBodyChildren(
    loop: LoopRecordView,
    input: LoopCardRenderInput,
  ): HTMLElement[] {
    const stats = document.createElement("div");
    stats.className = "loop-card-stats";

    const runsStat = this.buildStat("Runs", () => {
      const value = document.createElement("span");
      value.textContent = String(loop.runCount);
      return [value];
    });
    const runs = input.runsByLoopId.get(loop.id);
    const latestRun = runs !== undefined ? runs[0] : undefined;
    const lastRunStat = this.buildStat("Last run", () => {
      const parts: HTMLElement[] = [];
      if (latestRun) {
        const dot = document.createElement("span");
        dot.className = `loop-dot is-${latestRun.status}`;
        dot.title = runStatusLabel(latestRun.status);
        parts.push(dot);
      }
      const value = document.createElement("span");
      value.textContent = loop.lastRunAt
        ? formatRelativeTime(loop.lastRunAt)
        : "—";
      if (latestRun) value.title = runStatusLabel(latestRun.status);
      parts.push(value);
      return parts;
    });
    const nextRunStat = this.buildStat("Next run", () => {
      const value = document.createElement("span");
      value.textContent =
        loop.enabled && loop.nextRunAt != null
          ? formatDateTime(loop.nextRunAt)
          : "—";
      return [value];
    });
    stats.append(runsStat, lastRunStat, nextRunStat);

    return [stats];
  }

  private buildStat(
    label: string,
    buildValues: () => HTMLElement[],
  ): HTMLElement {
    const stat = document.createElement("div");
    stat.className = "loop-stat";
    const labelEl = document.createElement("span");
    labelEl.className = "loop-stat-label";
    labelEl.textContent = label;
    const valueEl = document.createElement("span");
    valueEl.className = "loop-stat-value";
    valueEl.append(...buildValues());
    stat.append(labelEl, valueEl);
    return stat;
  }

  private buildRunsPanel(
    loopId: string,
    input: LoopCardRenderInput,
  ): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "loop-card-runs";
    panel.dataset.loopId = loopId;

    const title = document.createElement("p");
    title.className = "loop-runs-title";
    title.textContent = "Recent runs";
    panel.append(title);

    if (input.runsLoading.has(loopId)) {
      const loading = document.createElement("p");
      loading.className = "loop-runs-empty";
      loading.textContent = "Loading runs…";
      panel.append(loading);
      return panel;
    }

    const runs = input.runsByLoopId.get(loopId) ?? [];
    if (runs.length === 0) {
      const empty = document.createElement("p");
      empty.className = "loop-runs-empty";
      empty.textContent = "No runs recorded yet.";
      panel.append(empty);
      return panel;
    }

    const list = document.createElement("div");
    list.className = "loop-run-list";
    for (const run of runs) {
      list.append(this.buildRunRow(run));
    }
    panel.append(list);
    return panel;
  }

  private buildRunRow(run: LoopRunRecord): HTMLElement {
    const row = document.createElement("div");
    row.className = "loop-run-row";

    const time = document.createElement("span");
    time.className = "loop-run-time";
    time.textContent = formatDateTime(run.startedAt);
    time.title = new Date(run.startedAt).toLocaleString();

    const status = document.createElement("span");
    status.className = `loop-run-status is-${run.status}`;
    status.textContent = runStatusLabel(run.status);

    row.append(time, status);

    if (run.error) {
      const error = document.createElement("span");
      error.className = "loop-run-error";
      error.textContent = run.error;
      error.title = run.error;
      row.append(error);
    }

    if (run.sessionId) {
      const sessionBtn = document.createElement("button");
      sessionBtn.type = "button";
      sessionBtn.className = "loop-run-session";
      sessionBtn.dataset.sessionId = run.sessionId;
      sessionBtn.textContent = `${run.sessionId.slice(0, 8)}…`;
      sessionBtn.title = `Open task ${run.sessionId}`;
      row.append(sessionBtn);
    } else {
      const none = document.createElement("span");
      none.className = "loop-run-session is-placeholder";
      none.textContent = "no task";
      row.append(none);
    }

    return row;
  }

  // --------------------------------------------------------------- editor

  editorOpen(): boolean {
    return !this.editorEl.hidden;
  }

  closeEditor(): void {
    this.editorEl.hidden = true;
  }

  setEditorError(message: string | null): void {
    this.editorErrorEl.textContent = message ?? "";
    this.editorErrorEl.classList.toggle("is-error", message != null);
    this.editorErrorEl.hidden = message == null;
  }

  openEditor(
    loop: LoopRecordView | null,
    defaults: LoopEditorDefaults,
    options: {
      workspaces: readonly LoopWorkspaceOption[];
      providers: readonly LoopProviderOption[];
    },
  ): void {
    this.setEditorError(null);
    this.editorTitleEl.textContent = loop ? "Edit Loop" : "New Loop";
    this.editorSaveBtn.textContent = loop ? "Save Changes" : "Create Loop";

    this.fillSelect(
      this.workspaceSelect,
      options.workspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.name,
      })),
      loop ? loop.workspaceId : defaults.workspaceId,
      "No workspaces available",
    );
    this.fillSelect(
      this.providerSelect,
      options.providers.map((provider) => ({
        value: provider.id,
        label: `${provider.name} · ${provider.modelId}`,
      })),
      loop ? loop.providerId : defaults.providerId,
      "No providers available",
    );

    this.nameInput.value = loop ? loop.name : "";
    this.promptInput.value = loop ? loop.prompt : "";
    this.runMode = loop ? loop.runMode : "agent";
    this.syncRunModeButtons();
    this.reasoningSeg.setLevel(loop ? loop.reasoningEffort : "low");
    this.fullPermissionsToggle.checked = loop ? loop.fullPermissions : false;
    this.enabledToggle.checked = loop ? loop.enabled : true;

    if (loop) {
      this.applyCadenceToDraft(loop.cadenceJson);
    } else {
      this.resetCadenceDraft();
    }
    this.kindSelect.value = this.cadenceKind;
    this.renderCadenceFields();

    this.editorEl.hidden = false;
    this.nameInput.focus();
    if (this.listEl.hidden) this.emptyEl.hidden = true;
  }

  private fillSelect(
    dropdown: AppDropdown,
    options: Array<{ value: string; label: string }>,
    selectedValue: string,
    emptyLabel: string,
  ): void {
    if (options.length === 0) {
      dropdown.update([{ value: "", label: emptyLabel }], "");
      return;
    }
    const known = options.some((option) => option.value === selectedValue);
    const list =
      selectedValue && !known
        ? [...options, { value: selectedValue, label: `${selectedValue} (missing)` }]
        : options;
    dropdown.update(list, selectedValue || (options[0]?.value ?? ""));
  }

  private resetCadenceDraft(): void {
    this.cadenceKind = "day";
    this.cadenceDraft.minuteN = "5";
    this.cadenceDraft.hourMinute = "0";
    this.cadenceDraft.time = "09:00";
    this.cadenceDraft.monthDay = "1";
    this.cadenceDraft.yearMonth = "1";
    this.cadenceDraft.yearDay = "1";
    this.weekdaySet.clear();
    this.weekdaySet.add(1);
  }

  /** Parse the stored cadence JSON into the editor draft; defaults on error. */
  private applyCadenceToDraft(cadenceJson: string): void {
    this.resetCadenceDraft();
    try {
      const parsed = JSON.parse(cadenceJson) as Partial<LoopCadence>;
      switch (parsed.kind) {
        case "minute":
          this.cadenceKind = "minute";
          if (typeof parsed.n === "number") {
            this.cadenceDraft.minuteN = String(parsed.n);
          }
          break;
        case "hour":
          this.cadenceKind = "hour";
          if (typeof parsed.minute === "number") {
            this.cadenceDraft.hourMinute = String(parsed.minute);
          }
          break;
        case "day":
          this.cadenceKind = "day";
          if (typeof parsed.time === "string") {
            this.cadenceDraft.time = parsed.time;
          }
          break;
        case "week": {
          this.cadenceKind = "week";
          if (Array.isArray(parsed.weekdays)) {
            this.weekdaySet.clear();
            for (const weekday of parsed.weekdays) {
              if (typeof weekday === "number") this.weekdaySet.add(weekday);
            }
            if (this.weekdaySet.size === 0) this.weekdaySet.add(1);
          }
          if (typeof parsed.time === "string") {
            this.cadenceDraft.time = parsed.time;
          }
          break;
        }
        case "month":
          this.cadenceKind = "month";
          if (typeof parsed.day === "number") {
            this.cadenceDraft.monthDay = String(parsed.day);
          }
          if (typeof parsed.time === "string") {
            this.cadenceDraft.time = parsed.time;
          }
          break;
        case "year":
          this.cadenceKind = "year";
          if (typeof parsed.month === "number") {
            this.cadenceDraft.yearMonth = String(parsed.month);
          }
          if (typeof parsed.day === "number") {
            this.cadenceDraft.yearDay = String(parsed.day);
          }
          if (typeof parsed.time === "string") {
            this.cadenceDraft.time = parsed.time;
          }
          break;
        default:
          this.resetCadenceDraft();
      }
    } catch {
      this.resetCadenceDraft();
    }
  }

  private renderCadenceFields(): void {
    const host = this.cadenceExtraEl;
    host.replaceChildren();

    const numberField = (
      label: string,
      value: string,
      min: number,
      max: number,
      onChange: (value: string) => void,
    ): HTMLElement => {
      const field = document.createElement("div");
      field.className = "setting-field";
      const labelEl = document.createElement("span");
      labelEl.className = "setting-field-label";
      labelEl.textContent = label;
      const input = document.createElement("input");
      input.type = "number";
      input.className = "setting-input";
      input.value = value;
      input.min = String(min);
      input.max = String(max);
      input.step = "1";
      input.addEventListener("input", () => onChange(input.value));
      field.append(labelEl, input);
      return field;
    };

    const timeField = (): HTMLElement => {
      const field = document.createElement("div");
      field.className = "setting-field";
      const labelEl = document.createElement("span");
      labelEl.className = "setting-field-label";
      labelEl.textContent = "Time";
      const input = document.createElement("input");
      input.type = "time";
      input.className = "setting-input";
      input.value = this.cadenceDraft.time;
      input.addEventListener("input", () => {
        this.cadenceDraft.time = input.value;
      });
      field.append(labelEl, input);
      return field;
    };

    switch (this.cadenceKind) {
      case "minute":
        host.append(
          numberField(
            "Interval (minutes)",
            this.cadenceDraft.minuteN,
            1,
            100000,
            (value) => {
              this.cadenceDraft.minuteN = value;
            },
          ),
        );
        break;
      case "hour":
        host.append(
          numberField(
            "Minute of hour (0–59)",
            this.cadenceDraft.hourMinute,
            0,
            59,
            (value) => {
              this.cadenceDraft.hourMinute = value;
            },
          ),
        );
        break;
      case "day":
        host.append(timeField());
        break;
      case "week": {
        const weekdays = document.createElement("div");
        weekdays.className = "setting-field";
        const labelEl = document.createElement("span");
        labelEl.className = "setting-field-label";
        labelEl.textContent = "Run on";
        const group = document.createElement("div");
        group.className = "loop-weekdays";
        WEEKDAY_LABELS.forEach((label, index) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "loop-weekday-btn";
          button.textContent = label;
          button.setAttribute("aria-pressed", String(this.weekdaySet.has(index)));
          if (this.weekdaySet.has(index)) button.classList.add("is-selected");
          button.addEventListener("click", () => {
            if (this.weekdaySet.has(index)) {
              this.weekdaySet.delete(index);
            } else {
              this.weekdaySet.add(index);
            }
            button.classList.toggle(
              "is-selected",
              this.weekdaySet.has(index),
            );
            button.setAttribute(
              "aria-pressed",
              String(this.weekdaySet.has(index)),
            );
          });
          group.append(button);
        });
        weekdays.append(labelEl, group);
        host.append(weekdays, timeField());
        break;
      }
      case "month":
        host.append(
          numberField(
            "Day of month (1–31)",
            this.cadenceDraft.monthDay,
            1,
            31,
            (value) => {
              this.cadenceDraft.monthDay = value;
            },
          ),
          timeField(),
        );
        break;
      case "year":
        host.append(
          numberField(
            "Month (1–12)",
            this.cadenceDraft.yearMonth,
            1,
            12,
            (value) => {
              this.cadenceDraft.yearMonth = value;
            },
          ),
          numberField(
            "Day (1–31)",
            this.cadenceDraft.yearDay,
            1,
            31,
            (value) => {
              this.cadenceDraft.yearDay = value;
            },
          ),
          timeField(),
        );
        break;
    }
  }

  /** Validate and assemble the editor form into a create/update payload. */
  collectInput(): CollectResult {
    const name = this.nameInput.value.trim();
    if (!name) return { ok: false, error: "Name is required." };
    const prompt = this.promptInput.value.trim();
    if (!prompt) return { ok: false, error: "Prompt is required." };
    const workspaceId = this.workspaceSelect.value;
    if (!workspaceId) return { ok: false, error: "Workspace is required." };
    const providerId = this.providerSelect.value;
    if (!providerId) return { ok: false, error: "Provider is required." };

    const cadence = this.buildCadence();
    if (typeof cadence === "string") return { ok: false, error: cadence };

    return {
      ok: true,
      payload: {
        name,
        prompt,
        workspaceId,
        runMode: this.runMode,
        providerId,
        reasoningEffort: this.reasoningSeg.getLevel(),
        fullPermissions: this.fullPermissionsToggle.checked,
        cadence,
        enabled: this.enabledToggle.checked,
      },
    };
  }

  private buildCadence(): LoopCadence | string {
    switch (this.cadenceKind) {
      case "minute": {
        const n = Number(this.cadenceDraft.minuteN);
        if (!Number.isInteger(n) || n < 1) {
          return "Interval must be a whole number of minutes (≥ 1).";
        }
        return { kind: "minute", n };
      }
      case "hour": {
        const minute = Number(this.cadenceDraft.hourMinute);
        if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
          return "Minute of hour must be a whole number between 0 and 59.";
        }
        return { kind: "hour", minute };
      }
      case "day": {
        const timeError = this.validateTime();
        if (timeError) return timeError;
        return { kind: "day", time: this.cadenceDraft.time };
      }
      case "week": {
        if (this.weekdaySet.size === 0) {
          return "Pick at least one weekday.";
        }
        const timeError = this.validateTime();
        if (timeError) return timeError;
        // Server validates strict ascending order — sort + dedupe here.
        const weekdays = [...this.weekdaySet].sort((a, b) => a - b);
        return { kind: "week", weekdays, time: this.cadenceDraft.time };
      }
      case "month": {
        const day = Number(this.cadenceDraft.monthDay);
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          return "Day of month must be a whole number between 1 and 31.";
        }
        const timeError = this.validateTime();
        if (timeError) return timeError;
        return { kind: "month", day, time: this.cadenceDraft.time };
      }
      case "year": {
        const month = Number(this.cadenceDraft.yearMonth);
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          return "Month must be a whole number between 1 and 12.";
        }
        const day = Number(this.cadenceDraft.yearDay);
        if (!Number.isInteger(day) || day < 1 || day > 31) {
          return "Day must be a whole number between 1 and 31.";
        }
        const timeError = this.validateTime();
        if (timeError) return timeError;
        return { kind: "year", month, day, time: this.cadenceDraft.time };
      }
    }
  }

  private validateTime(): string | null {
    if (!TIME_OF_DAY_RE.test(this.cadenceDraft.time)) {
      return "Time must be a valid 24-hour HH:MM value.";
    }
    return null;
  }

  private syncRunModeButtons(): void {
    for (const [mode, button] of this.runModeButtons) {
      button.classList.toggle("is-selected", mode === this.runMode);
      button.setAttribute("aria-pressed", String(mode === this.runMode));
    }
  }

  private buildEditor(): {
    root: HTMLElement;
    titleEl: HTMLElement;
    errorEl: HTMLElement;
    nameInput: HTMLInputElement;
    promptInput: HTMLTextAreaElement;
    kindSelect: AppDropdown;
    cadenceExtraEl: HTMLElement;
    workspaceSelect: AppDropdown;
    providerSelect: AppDropdown;
    runModeButtons: Map<string, HTMLButtonElement>;
    reasoningSeg: EffortSegView;
    fullPermissionsToggle: HTMLInputElement;
    enabledToggle: HTMLInputElement;
    cancelBtn: HTMLButtonElement;
    saveBtn: HTMLButtonElement;
  } {
    const root = document.createElement("article");
    root.className = "setting-card loop-editor";
    root.hidden = true;

    const header = document.createElement("div");
    header.className = "setting-card-header";
    const icon = document.createElement("div");
    icon.className = "setting-card-icon";
    icon.append(createLucideIcon(RotateCcwClock, { size: 18 }));
    const titles = document.createElement("div");
    titles.className = "setting-card-titles";
    const titleEl = document.createElement("h2");
    titleEl.className = "setting-card-title";
    titleEl.textContent = "New Loop";
    const descEl = document.createElement("p");
    descEl.className = "setting-card-desc";
    descEl.textContent =
      "Runs the prompt headlessly via the background daemon and files each run as a task.";
    titles.append(titleEl, descEl);
    header.append(icon, titles);

    const body = document.createElement("div");
    body.className = "setting-card-body";

    const makeField = (label: string, hint?: string): HTMLElement => {
      const field = document.createElement("div");
      field.className = "setting-field";
      const labelEl = document.createElement("span");
      labelEl.className = "setting-field-label";
      labelEl.textContent = label;
      field.append(labelEl);
      if (hint) {
        const hintEl = document.createElement("span");
        hintEl.className = "setting-field-hint";
        hintEl.textContent = hint;
        field.append(hintEl);
      }
      return field;
    };

    const makeToggle = (
      label: string,
      hint?: string,
    ): { row: HTMLLabelElement; input: HTMLInputElement } => {
      const row = document.createElement("label");
      row.className = "setting-toggle-row";
      const copy = document.createElement("div");
      copy.className = "setting-toggle-copy";
      const labelEl = document.createElement("span");
      labelEl.className = "setting-field-label";
      labelEl.textContent = label;
      copy.append(labelEl);
      if (hint) {
        const hintEl = document.createElement("span");
        hintEl.className = "setting-field-hint";
        hintEl.textContent = hint;
        copy.append(hintEl);
      }
      const input = document.createElement("input");
      input.type = "checkbox";
      input.className = "setting-toggle";
      row.append(copy, input);
      return { row, input };
    };

    // Name
    const nameField = makeField("Name");
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "setting-input";
    nameInput.placeholder = "e.g. Morning standup digest";
    nameField.append(nameInput);

    // Prompt
    const promptField = makeField(
      "Prompt",
      "Sent as the user message at the start of every run.",
    );
    const promptInput = document.createElement("textarea");
    promptInput.className = "setting-input setting-textarea";
    promptInput.style.minHeight = "96px";
    promptInput.placeholder = "e.g. Check the build status and summarize…";
    promptField.append(promptInput);

    // Cadence
    const cadenceRow = document.createElement("div");
    cadenceRow.className = "loop-cadence-kind-row";
    const kindField = makeField("Schedule");
    const kindSelect = new AppDropdown(
      CADENCE_KIND_OPTIONS.map((option) => ({
        value: option.id,
        label: option.label,
      })),
      CADENCE_KIND_OPTIONS[0]!.id,
      { ariaLabel: "Schedule" },
    );
    kindField.append(kindSelect.el);
    const cadenceExtraEl = document.createElement("div");
    cadenceExtraEl.className = "loop-cadence-extra";
    cadenceRow.append(kindField, cadenceExtraEl);

    // Workspace
    const workspaceField = makeField(
      "Workspace",
      "Where each run's task is filed.",
    );
    const workspaceSelect = new AppDropdown([], "", { ariaLabel: "Workspace" });
    workspaceField.append(workspaceSelect.el);

    // Run mode
    const runModeField = makeField("Run mode");
    const runModeButtons = new Map<string, HTMLButtonElement>();
    const segmented = document.createElement("div");
    segmented.className = "loop-segmented";
    segmented.setAttribute("role", "group");
    segmented.setAttribute("aria-label", "Run mode");
    for (const mode of RUN_MODES) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "loop-segmented-btn";
      button.textContent = mode.label;
      button.addEventListener("click", () => {
        this.runMode = mode.id;
        this.syncRunModeButtons();
      });
      runModeButtons.set(mode.id, button);
      segmented.append(button);
    }
    runModeField.append(segmented);

    // Provider
    const providerField = makeField(
      "Provider",
      "LLM profile used for every run.",
    );
    const providerSelect = new AppDropdown([], "", { ariaLabel: "Provider" });
    providerField.append(providerSelect.el);

    // Reasoning effort dial
    const reasoningField = makeField(
      "Effort",
      "Dial level sent on every run (OFF/LOW/MED/HIGH/MAX).",
    );
    const reasoningSeg = new EffortSegView({
      onSelect: () => {},
      ariaLabel: "Loop effort",
    });
    reasoningField.append(reasoningSeg.root);

    const fullPermissions = makeToggle(
      "Full permissions",
      "When on, background runs auto-approve every tool request for fully unattended execution. Off (default): the global tool whitelist applies and tools outside the whitelist are denied.",
    );
    const enabled = makeToggle(
      "Enabled",
      "Disabled loops keep their config but never fire.",
    );

    body.append(
      nameField,
      promptField,
      cadenceRow,
      workspaceField,
      runModeField,
      providerField,
      reasoningField,
      fullPermissions.row,
      enabled.row,
    );

    const footer = document.createElement("div");
    footer.className = "setting-card-footer";
    const errorEl = document.createElement("p");
    errorEl.className = "setting-card-status";
    errorEl.hidden = true;
    const actions = document.createElement("div");
    actions.className = "setting-card-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "setting-btn";
    cancelBtn.textContent = "Cancel";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "setting-btn setting-btn-primary action-primary";
    saveBtn.textContent = "Create Loop";
    actions.append(cancelBtn, saveBtn);
    footer.append(errorEl, actions);

    root.append(header, body, footer);

    return {
      root,
      titleEl,
      errorEl,
      nameInput,
      promptInput,
      kindSelect,
      cadenceExtraEl,
      workspaceSelect,
      providerSelect,
      runModeButtons,
      reasoningSeg,
      fullPermissionsToggle: fullPermissions.input,
      enabledToggle: enabled.input,
      cancelBtn,
      saveBtn,
    };
  }
}
