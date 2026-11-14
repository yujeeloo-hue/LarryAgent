import type { DemoCardState, DemoSettled, DemoSubmitReceipt } from "../../../src/session/demoCardState.js";
/**
 * DOM rendering: sessions table, conversation stream (message parts + live
 * events), ask card, manage cards. Pure builders — state lives in main.ts.
 */
import { icon } from "./icons.js";
import { cardHeaderIcon } from "./cardHeaderIcons.js";
import { cocoIconMarkup } from "./cocoIcons.js";
import { renderChatStream, ChatLiveStream } from "./chat.js";
import { syncMenuScrim, mountPopoverMenu } from "./mobileNav.js";
import { releaseVersionFromFile, type MaintenanceChannel } from "./maintenanceChannel.js";
import type {
  AuditEntry,
  DeviceMaintenanceState,
  DeviceExecResult,
  DeviceSummary,
  PromptLogEntry,
  Session,
  SessionSummary,
  SessionStatus,
} from "./types.js";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | undefined | ((e: Event) => void)> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === "function") node.addEventListener(k.replace(/^on/, ""), v as EventListener);
    else if (typeof v === "boolean") {
      if (v) node.setAttribute(k, "");
    } else if (v !== undefined) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    if (typeof c === "string") {
      if (c.startsWith("<svg")) {
        // Inline icon markup — parse into real nodes, never text (rendering
        // the raw source was the bug).
        const tpl = document.createElement("template");
        tpl.innerHTML = c;
        node.append(tpl.content);
      } else {
        node.append(document.createTextNode(c));
      }
    } else {
      node.append(c);
    }
  }
  return node;
}

/** Shared desktop footer for the console and its interactive website example. */
export function renderSidebarFooter(opts: {
  devicesIcon: HTMLElement;
  manageIcon: HTMLElement;
  onDevices: () => void;
  onManage: () => void;
  onSignOut: () => void;
}): HTMLElement {
  return el("div", { class: "side-footer" },
    el("button", { class: "footer-btn", type: "button", title: "Devices", onclick: opts.onDevices },
      opts.devicesIcon, "Devices"),
    el("button", { class: "footer-btn", type: "button", title: "Manage", onclick: opts.onManage },
      opts.manageIcon, "Manage"),
    el("button", { class: "footer-btn footer-signout", type: "button", title: "Sign out", onclick: opts.onSignOut },
      icon("logout", 15), "Sign out"),
  );
}

export function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export type PillStatus = SessionStatus | "streaming" | "tool_running";

export function statusPill(status: PillStatus): { cls: string; label: string } {
  switch (status) {
    case "running":
    case "streaming":
    case "tool_running":
      return { cls: "running", label: "Running" };
    case "paused": return { cls: "waiting", label: "Paused" };
    case "error": return { cls: "error", label: "Error" };
    case "completed": return { cls: "idle", label: "Done" };
    case "cancelled": return { cls: "idle", label: "Cancelled" };
    default: return { cls: "idle", label: "Idle" };
  }
}

// ── sessions table ───────────────────────────────────────────
/**
 * Session list. Rows are divs (role=button), not <button>: the delete
 * affordance nests inside and HTML forbids button-in-button. `onDelete`
 * absent → no trash buttons render at all (device too old for remote
 * delete — the console gates it on device version ≥ 1.3.4).
 */
export function renderSessionList(
  sessions: SessionSummary[],
  activeId: string | null,
  onOpen: (s: SessionSummary) => void,
  onDelete?: (s: SessionSummary) => void,
): HTMLElement {
  const list = el("div", { class: "session-list" });
  for (const s of sessions) {
    const p = statusPill(s.status);
    const light = p.cls === "running" ? "run" : p.cls === "waiting" ? "warn" : p.cls === "error" ? "error" : "idle";
    const row = el("div", {
      class: `session-row${s.id === activeId ? " active" : ""}`,
      role: "button",
      tabindex: "0",
      onclick: () => onOpen(s),
      onkeydown: (e: Event) => {
        const ke = e as KeyboardEvent;
        if (ke.key === "Enter" || ke.key === " ") {
          ke.preventDefault();
          onOpen(s);
        }
      },
    },
      el("span", { class: `session-light is-${light}`, title: p.label }),
      el("span", { class: "session-title" }, s.title || "Untitled"),
      // Relative time only — the old messageCount was always 0 on lazy
      // (un-hydrated) device summaries and read like a stale badge.
      el("span", { class: "session-meta" }, relTime(s.updatedAt)),
    );
    if (onDelete) {
      row.append(
        el("button", {
          class: "session-delete",
          type: "button",
          title: "Delete session",
          "aria-label": `Delete session ${s.title || "Untitled"}`,
          onclick: (e: Event) => {
            // Row click opens the session — the trash must not bubble.
            e.stopPropagation();
            onDelete(s);
          },
        }, icon("trash2", 14)),
      );
    }
    list.append(row);
  }
  return list;
}

// ── new task (create session) ────────────────────────────────
/** Project picker option — mirrors the device listWorkspaces shape. */
export interface NewTaskWorkspaceOption {
  id: string;
  name: string;
  path: string;
}

/** Result contract for the New Project… create flow (device createWorkspace). */
export type CreateWorkspaceResult =
  | { ok: true; workspace: NewTaskWorkspaceOption; existing: boolean }
  | { ok: false; error: string };

/** Result contract for the folder browser (device browseDir). */
export type BrowseDirResult =
  | { ok: true; path: string; parent: string | null; dirs: string[] }
  | { ok: false; error: string };

export interface NewTaskPanel {
  root: HTMLElement;
  textarea: HTMLTextAreaElement;
  /** Invoke the composer's send path (guards apply) — for toolbar wiring. */
  triggerSend(): void;
  /** Toggle the in-flight state (locks composer + send button). */
  setBusy(busy: boolean): void;
  showError(msg: string): void;
  clearError(): void;
  /**
   * The project picker popover is open (list / create form / folder
   * browser). While true the owner must NOT rebuild the panel — a late
   * async response (composer probe, workspace refresh) used to repaint
   * over the open folder browser and close it.
   */
  isMenuOpen(): boolean;
}

/**
 * New Task panel — port of the Mac New Task screen (hero, project picker,
 * composer). With `onCreateWorkspace` the picker menu also hosts the
 * New Project… flow (inline form + device folder browser); legacy device
 * builds that lack the actions simply don't get the entry points.
 */
export function buildNewTaskPanel(opts: {
  workspaces: readonly NewTaskWorkspaceOption[];
  selectedWorkspaceId: string | null;
  draft: string;
  /** When set, the composer is disabled and the note is shown (offline…). */
  disabledNote?: string | null;
  heroIconUrl: string;
  /**
   * Mac-parity composer controls (attachments + LLM + toggles). Absent on
   * legacy device builds — the panel falls back to the plain composer.
   */
  toolbar?: {
    root: HTMLElement;
    attachments: HTMLElement;
    setSendDisabled: (disabled: boolean) => void;
    setRunning: (running: boolean) => void;
  } | null;
  /**
   * Capability probe unresolved on an online device — render the loading
   * placeholder instead of any composer surface (never flash a default
   * composer; the settle repaint brings the real one in).
   */
  composerLoading?: boolean;
  onPickWorkspace(workspaceId: string): void;
  onSend(text: string, workspaceId: string | null): void;
  /** New Project… submit (device createWorkspace). Absent = entry hidden. */
  onCreateWorkspace?: (name: string, path: string) => Promise<CreateWorkspaceResult>;
  /** Folder browser data source (device browseDir). Absent = browse button hidden. */
  onBrowseDir?: (path: null | string) => Promise<BrowseDirResult>;
  /** Fired once the picker popover fully closes (after the exit transition). */
  onMenuClosed?: () => void;
}): NewTaskPanel {
  const disabled = Boolean(opts.disabledNote);
  let busy = false;
  let selectedId =
    opts.workspaces.find((w) => w.id === opts.selectedWorkspaceId)?.id ??
    opts.workspaces[0]?.id ??
    null;

  const heroIcon = el("img", {
    class: "welcome-hero-icon",
    src: opts.heroIconUrl,
    alt: "",
    draggable: "false",
  });
  const root = el("section", { class: "new-task-view" },
    el("div", { class: "welcome-hero" },
      heroIcon,
      el("h1", { class: "welcome-title" }, "What should we work on?"),
    ),
  );

  // ── project picker (Mac new-task-workspace-bar) ─────────────
  const wsName = el("span", { class: "new-task-workspace-name" }, "Loading…");
  const wsChevron = el("span", { class: "new-task-workspace-chevron", "aria-hidden": "true" }, icon("chevronDown", 14));
  const wsButton = el("button", {
    class: "new-task-workspace-btn",
    type: "button",
    "aria-haspopup": "listbox",
    "aria-expanded": "false",
  },
    el("span", { class: "new-task-workspace-icon" }, icon("folder", 14)),
    el("span", { class: "new-task-workspace-label" }, "Project"),
    wsName,
    wsChevron,
  );
  const wsMenu = el("div", { class: "new-task-workspace-menu", role: "menu", "aria-label": "Projects", hidden: true });
  const wsBar = el("div", { class: "new-task-workspace-bar" }, wsButton, wsMenu);
  root.append(wsBar);

  let menuCloseTimer: number | null = null;
  const setMenuOpen = (open: boolean) => {
    wsButton.setAttribute("aria-expanded", open ? "true" : "false");
    wsButton.classList.toggle("is-open", open);
    if (open) {
      if (menuCloseTimer !== null) {
        window.clearTimeout(menuCloseTimer);
        menuCloseTimer = null;
      }
      mountPopoverMenu(wsMenu, wsBar);
      wsMenu.hidden = false;
      // Reflow so the enter transition starts from the closed state.
      void (wsMenu as HTMLElement).offsetWidth;
      wsMenu.classList.add("is-open");
      // Mobile: the menu restyles into a bottom sheet behind the global scrim.
      syncMenuScrim(true, () => setMenuOpen(false), wsMenu);
    } else {
      wsMenu.classList.remove("is-open");
      syncMenuScrim(false, undefined, wsMenu);
      if (menuCloseTimer === null) {
        menuCloseTimer = window.setTimeout(() => {
          menuCloseTimer = null;
          wsMenu.hidden = true;
          // Back to the project list for the next open.
          showMenuView("list");
          // Owner may have deferred a repaint while the menu was open.
          opts.onMenuClosed?.();
        }, 180);
      }
    }
  };
  const isMenuOpen = () => wsMenu.classList.contains("is-open");

  // ── menu views: list · create form · folder browser ────────
  const menuList = el("div", { class: "ws-menu-list" });
  const showMenuView = (view: "list" | "form" | "browse") => {
    menuList.hidden = view !== "list";
    menuForm.hidden = view !== "form";
    menuBrowse.hidden = view !== "browse";
    if (view === "list") hideFormError();
  };

  // create form --------------------------------------------------
  const canCreate = typeof opts.onCreateWorkspace === "function";
  const nameInput = el("input", {
    class: "ws-input",
    type: "text",
    placeholder: "My Project",
    maxlength: "60",
    autocomplete: "off",
    "aria-label": "Project name",
  }) as HTMLInputElement;
  const pathInput = el("input", {
    class: "ws-input mono",
    type: "text",
    placeholder: "/Users/you/Developer/my-project",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Project path on the device",
  }) as HTMLInputElement;
  const formErrorText = el("span");
  const formError = el("div", { class: "ws-form-error", hidden: true },
    icon("circleAlert", 13), formErrorText);
  const hideFormError = () => { formError.hidden = true; };
  const showFormError = (msg: string) => { formErrorText.textContent = msg; formError.hidden = false; };
  const createBtn = el("button", { class: "btn primary action-primary", type: "submit" }, "Create Project") as HTMLButtonElement;
  let createBusy = false;
  const syncCreateBusy = () => {
    createBtn.disabled = createBusy;
    createBtn.setAttribute("aria-busy", String(createBusy));
    createBtn.replaceChildren(
      ...(createBusy
        ? [el("span", { class: "spinner ws-btn-spinner", "aria-hidden": "true" })]
        : []),
      document.createTextNode(createBusy ? "Creating…" : "Create Project"),
    );
  };
  const canBrowse = typeof opts.onBrowseDir === "function";
  const browseBtn = el("button", {
    class: "ws-browse-btn",
    type: "button",
    title: "Browse folders on the device",
    "aria-label": "Browse folders on the device",
    onclick: () => void openBrowse(resolveBrowseStart()),
  }, icon("folderOpen", 14));
  const menuForm = el("form", { class: "ws-form", hidden: true, autocomplete: "off" },
    el("div", { class: "ws-form-head" },
      el("button", {
        class: "ws-back-btn", type: "button", title: "Back", "aria-label": "Back",
        onclick: () => showMenuView("list"),
      }, icon("back", 15)),
      el("span", { class: "ws-form-title" }, "New Project")),
    el("label", { class: "ws-field" },
      el("span", { class: "ws-field-label" }, "Name"),
      nameInput),
    el("label", { class: "ws-field" },
      el("span", { class: "ws-field-label" }, "Path"),
      el("span", { class: "ws-input-wrap" }, pathInput, canBrowse ? browseBtn : null)),
    el("p", { class: "ws-hint" },
      "Pick the folder on the device — browse, or type an absolute path. A missing folder is created."),
    formError,
    el("div", { class: "ws-form-actions" },
      el("button", {
        class: "btn ghost", type: "button",
        onclick: () => setMenuOpen(false),
      }, "Cancel"),
      createBtn),
  );
  menuForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (createBusy || !opts.onCreateWorkspace) return;
    const name = nameInput.value.trim();
    const path = pathInput.value.trim();
    if (!name) return showFormError("Name is required.");
    if (!path) return showFormError("Path is required.");
    if (!path.startsWith("/")) return showFormError("Path must be absolute on the device (e.g. /Users/…).");
    hideFormError();
    createBusy = true;
    syncCreateBusy();
    void opts.onCreateWorkspace(name, path).then((res) => {
      createBusy = false;
      syncCreateBusy();
      if (!res.ok) {
        showFormError(res.error);
        return;
      }
      // Success: main.ts re-renders the panel with the new workspace —
      // just close. `existing` merges as a pick, not an error.
      setMenuOpen(false);
    });
  });

  // folder browser -----------------------------------------------
  const browsePathText = el("span", { class: "ws-path-text" });
  const browseUpBtn = el("button", {
    class: "ws-up-btn", type: "button", title: "Parent folder", "aria-label": "Parent folder",
    onclick: () => {
      if (browseState?.parent) void openBrowse(browseState.parent);
    },
  }, icon("arrowUp", 13)) as HTMLButtonElement;
  const dirList = el("div", { class: "ws-dir-list", role: "listbox", "aria-label": "Folders" });
  const chooseLabel = el("span", { class: "ws-choose-label" });
  const menuBrowse = el("div", { class: "ws-browse", hidden: true },
    el("div", { class: "ws-form-head" },
      el("button", {
        class: "ws-back-btn", type: "button", title: "Back", "aria-label": "Back to the form",
        onclick: () => showMenuView("form"),
      }, icon("back", 15)),
      el("span", { class: "ws-form-title" }, "Choose Folder")),
    el("div", { class: "ws-pathbar" }, icon("house", 13), browsePathText, browseUpBtn),
    dirList,
    el("div", { class: "ws-choose-row" },
      chooseLabel,
      el("button", {
        class: "btn ghost", type: "button",
        onclick: () => setMenuOpen(false),
      }, "Cancel"),
      el("button", {
        class: "btn primary action-primary", type: "button",
        onclick: () => {
          if (!browseState) return;
          pathInput.value = browseState.path;
          showMenuView("form");
          pathInput.focus();
        },
      }, "Choose This Folder")),
  );
  let browseState: { path: string; parent: string | null; dirs: string[] } | null = null;
  /** Smart start: the typed path itself, falling back to home. */
  const resolveBrowseStart = (): string | null => {
    const typed = pathInput.value.trim();
    return typed.startsWith("/") ? typed : null;
  };
  const renderBrowseLoading = (path: string | null) => {
    browsePathText.textContent = path ?? "";
    browseUpBtn.disabled = true;
    chooseLabel.textContent = "";
    dirList.replaceChildren(el("div", { class: "ws-dir-note" },
      el("span", { class: "spinner ws-btn-spinner", "aria-hidden": "true" }), "Reading…"));
  };
  const openBrowse = async (path: string | null) => {
    if (!opts.onBrowseDir) return;
    showMenuView("browse");
    renderBrowseLoading(path);
    let res = await opts.onBrowseDir(path);
    if (!res.ok && path !== null) {
      // Typed start didn't exist (or isn't browsable) — restart from home.
      renderBrowseLoading(null);
      res = await opts.onBrowseDir(null);
    }
    if (!res.ok) {
      dirList.replaceChildren(el("div", { class: "ws-dir-note" }, res.error));
      return;
    }
    browseState = res;
    browsePathText.textContent = res.path;
    browseUpBtn.disabled = res.parent === null;
    chooseLabel.textContent = res.path;
    chooseLabel.title = res.path;
    dirList.replaceChildren();
    if (res.dirs.length === 0) {
      dirList.append(el("div", { class: "ws-dir-note" }, "No subfolders — use Choose This Folder."));
      return;
    }
    for (const dir of res.dirs) {
      const full = res.path === "/" ? `/${dir}` : `${res.path}/${dir}`;
      dirList.append(el("button", {
        class: "ws-dir-item",
        type: "button",
        role: "option",
        onclick: () => void openBrowse(full),
      }, icon("folder", 15), el("span", { class: "ws-dir-name" }, dir)));
    }
  };

  const renderMenu = () => {
    menuList.replaceChildren();
    if (opts.workspaces.length === 0 && !canCreate) {
      menuList.append(el("p", { class: "new-task-workspace-menu-empty" }, "No projects yet."));
      return;
    }
    for (const workspace of opts.workspaces) {
      const active = workspace.id === selectedId;
      menuList.append(el("button", {
        class: `new-task-workspace-item${active ? " is-active" : ""}`,
        type: "button",
        role: "option",
        "aria-selected": active ? "true" : "false",
        onclick: (e) => {
          e.stopPropagation();
          setMenuOpen(false);
          if (workspace.id !== selectedId) {
            selectedId = workspace.id;
            wsName.textContent = workspace.name;
            renderMenu();
            opts.onPickWorkspace(workspace.id);
          }
        },
      },
        el("span", { class: "new-task-workspace-item-name" }, workspace.name),
        el("span", { class: "new-task-workspace-item-path", title: workspace.path }, workspace.path),
      ));
    }
    if (canCreate) {
      menuList.append(
        el("div", { class: "ws-menu-sep", "aria-hidden": "true" }),
        el("button", {
          class: "ws-new-project action-primary",
          type: "button",
          onclick: (e) => {
            e.stopPropagation();
            hideFormError();
            showMenuView("form");
            nameInput.focus();
          },
        }, icon("folderPlus", 15), el("span", {}, "New Project…")),
      );
    }
  };
  wsMenu.append(menuList, menuForm, menuBrowse);

  const syncWorkspaceLabel = () => {
    const selected = opts.workspaces.find((w) => w.id === selectedId) ?? null;
    wsName.textContent = selected?.name ?? "No projects";
  };
  syncWorkspaceLabel();
  renderMenu();

  wsButton.addEventListener("click", (e) => {
    e.stopPropagation();
    setMenuOpen(!isMenuOpen());
  });
  // Outside-click closes the menu; self-removes once the panel is gone
  // (the view rebuilds on device/data changes). A create submit in flight
  // owns the menu — never tear it down mid-request. Clicks INSIDE the
  // popover (or on the trigger) are not "outside". The listener runs in
  // the CAPTURE phase on purpose: inner handlers (folder rows) rebuild
  // their subtree synchronously, which detaches the click target — by
  // bubble time wsMenu.contains(target) would be false and the menu would
  // slam shut on every folder navigation.
  const onDocClick = (ev: MouseEvent) => {
    if (!root.isConnected) {
      document.removeEventListener("click", onDocClick, true);
      return;
    }
    const target = ev.target as Node | null;
    if (target && (wsMenu.contains(target) || wsButton.contains(target))) return;
    if (isMenuOpen() && !createBusy) setMenuOpen(false);
  };
  document.addEventListener("click", onDocClick, true);

  // ── composer ────────────────────────────────────────────────
  const textarea = el("textarea", {
    rows: "1",
    placeholder: "Ask to build, fix, or explore… (Enter to send)",
    "aria-label": "New task prompt",
    disabled,
  }) as HTMLTextAreaElement;
  /** Legacy fallback only — with a toolbar the round send button lives in it. */
  const legacySendBtn = el("button", { class: "send-btn", type: "button", disabled: true }, icon("send", 13), "Send") as HTMLButtonElement;
  const composeError = el("div", { class: "compose-error", hidden: true });

  const autoGrow = () => {
    textarea.style.height = "auto";
    // Phone typography has a taller line box than the desktop's 13.5px.
    const line = Number.parseFloat(window.getComputedStyle?.(textarea).lineHeight ?? "") || 20.25;
    textarea.style.height = `${Math.min(5 * line, Math.max(1 * line, textarea.scrollHeight))}px`;
  };
  let sendBlocked = true;
  const syncSend = () => {
    const blocked = disabled || busy || !textarea.value.trim() || !selectedId;
    sendBlocked = blocked;
    if (opts.toolbar) opts.toolbar.setSendDisabled(blocked);
    else legacySendBtn.disabled = blocked;
  };
  textarea.addEventListener("input", () => {
    autoGrow();
    syncSend();
  });
  if (opts.draft) {
    textarea.value = opts.draft;
    autoGrow();
  }
  syncSend();

  const send = () => {
    if (sendBlocked) return;
    opts.onSend(textarea.value.trim(), selectedId);
  };
  legacySendBtn.addEventListener("click", () => send());
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !(e as KeyboardEvent).isComposing) {
      e.preventDefault();
      send();
    }
  });

  const composerBox = opts.composerLoading
    ? el("div", { class: "composer new-task-composer" }, buildComposerLoading())
    : opts.toolbar
      ? el("div", { class: "composer new-task-composer" },
          el("div", { class: "composer-card" },
            opts.toolbar.attachments,
            textarea,
            opts.toolbar.root,
            composeError))
      : el("div", { class: "composer new-task-composer" },
          el("div", { class: "composer-row" }, textarea, legacySendBtn),
          composeError);
  root.append(composerBox);

  if (disabled && opts.disabledNote) {
    composeError.textContent = opts.disabledNote;
    composeError.classList.add("is-note");
    composeError.hidden = false;
  }

  return {
    root,
    textarea,
    /** Invoke the composer's send path (guards apply) — for toolbar wiring. */
    triggerSend: () => send(),
    isMenuOpen,
    setBusy(next: boolean) {
      busy = next;
      textarea.disabled = next || disabled;
      syncSend();
    },
    showError(msg: string) {
      composeError.classList.remove("is-note");
      composeError.textContent = msg;
      composeError.hidden = false;
    },
    clearError() {
      if (disabled && opts.disabledNote) return;
      composeError.hidden = true;
      composeError.textContent = "";
    },
  };
}

// ── conversation ─────────────────────────────────────────────
/**
 * Composer-area loading placeholder. Shown while the device capability
 * probe is unresolved on an online device (providers list in flight or
 * retrying) — the composer never flashes a default surface; the settle
 * repaint swaps in the real one (Mac-parity toolbar or legacy row).
 */
export function buildComposerLoading(label = "Loading composer…"): HTMLElement {
  return el("div", { class: "composer-loading", role: "status", "aria-live": "polite" },
    el("span", { class: "spinner composer-loading-spinner", "aria-hidden": "true" }),
    el("span", { class: "composer-loading-label" }, label));
}

export interface ConversationCallbacks {
  onAnswerAsk(requestId: string, answer: { selected: string; selections?: string[]; custom: boolean }): void;
  onCancel(): void;
  /** present_demo: settled values per call id + the one open call. */
  demoSettledByCallId?: Map<string, DemoSettled> | null;
  demoOpenCallId?: string | null;
  demoStates?: Map<string, DemoCardState>;
  onSubmitDemoParams?: (
    toolCallId: string,
    values: Record<string, string | number | boolean | null>,
    note?: string,
  ) => void | Promise<void | DemoSubmitReceipt>;
}

export function renderConversation(
  session: Session,
  cb: ConversationCallbacks,
): { stream: HTMLElement } {
  const stream = renderChatStream(session, {
    pendingAsk: session.pendingUserAsk ?? null,
    onAnswerAsk: (requestId, answer) => cb.onAnswerAsk(requestId, answer),
    ...(cb.demoStates ? { demoStates: cb.demoStates } : {}),
    ...(cb.demoSettledByCallId
      ? { demoSettledByCallId: cb.demoSettledByCallId }
      : {}),
    ...(cb.demoOpenCallId !== undefined
      ? { demoOpenCallId: cb.demoOpenCallId }
      : {}),
    ...(cb.onSubmitDemoParams
      ? {
          onSubmitDemoParams: (
            toolCallId: string,
            values: Record<string, string | number | boolean | null>,
            note?: string,
          ) => cb.onSubmitDemoParams?.(toolCallId, values, note),
        }
      : {}),
  });
  stream.scrollTop = stream.scrollHeight;
  // Desktop parity (drop composer statusEl): no status pill at the composer
  // top-right — the live status text rides the Thinking block's title,
  // seeded by main.ts and driven by stream events.
  return { stream };
}

export { ChatLiveStream };

// ── manage ───────────────────────────────────────────────────
export function renderManageCards(opts: {
  currentKeyId: string | null;
  account: { username: string };
  onChangeAccount: (currentPassword: string, username: string | undefined, password: string | undefined) => void;
  keys: import("./types.js").KeySummary[];
  freshKey: { name: string; key: string } | null;
  info: import("./types.js").ServerInfo | null;
  audit: AuditEntry[];
  /** Wipe the server-side audit log. */
  onClearAudit: () => void;
  prompts: PromptLogEntry[];
  devices: DeviceSummary[];
  onCreateKey: () => void;
  onCopyKey: (k: import("./types.js").KeySummary) => Promise<boolean>;
  onRenameKey: (k: import("./types.js").KeySummary) => void;
  onRotateKey: (k: import("./types.js").KeySummary) => void;
  onDeleteKey: (k: import("./types.js").KeySummary) => void;
  onDismissFreshKey: () => void;
  onBlock: (d: DeviceSummary, blocked: boolean) => void;
  onRemove: (d: DeviceSummary) => void;
  /** IP security (bans + active throttle state); omitted → card hidden. */
  security?: {
    bans: Array<{ ip: string; reason: string; bannedAt: number; expiresAt: number }>;
    failures: Array<{ ip: string; failures: number; strikes: number; blockedUntil: number }>;
  };
  onBanIp?: (ip: string) => void;
  onUnbanIp?: (ip: string) => void;
}): HTMLElement {
  const body = el("div", { class: "manage-body" });

  // API keys card
  // Copy button factory — the desktop zebra row wants a labelled ghost
  // button, the mobile row card an icon-only one; the copy state machine
  // (Copied/Failed + restore) is shared.
  const makeKeyCopyBtn = (k: import("./types.js").KeySummary, iconOnly: boolean): HTMLButtonElement => {
    const btn = el("button", {
      class: iconOnly ? "m-row-btn" : "ghost-btn",
      type: "button",
      title: "Copy key",
      "aria-label": `Copy key ${k.name}`,
    }, icon("copy", iconOnly ? 15 : 12), iconOnly ? null : "Copy") as HTMLButtonElement;
    const setBtn = (iconName: string, label: string) => {
      const tpl = document.createElement("template");
      tpl.innerHTML = icon(iconName, iconOnly ? 15 : 12);
      btn.replaceChildren(tpl.content, ...(iconOnly ? [] : [document.createTextNode(label)]));
    };
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      btn.disabled = true;
      let settled = false;
      const restore = () => window.setTimeout(() => {
        setBtn("copy", "Copy");
        btn.disabled = false;
      }, 1500);
      void opts.onCopyKey(k).then((ok) => {
        if (settled) return;
        settled = true;
        setBtn(ok ? "check" : "x", ok ? "Copied" : "Failed");
        restore();
      }).catch(() => {
        if (settled) return;
        settled = true;
        setBtn("x", "Failed");
        restore();
      });
    });
    return btn;
  };
  const keyTbody = el("tbody");
  const keyMobileRows = el("div", { class: "m-rows", "aria-label": "API keys" });
  for (const k of opts.keys) {
    const isCurrent = opts.currentKeyId !== null && k.id === opts.currentKeyId;
    keyTbody.append(el("tr", { class: "static" },
      el("td", {},
        el("span", { class: "cell-title" }, k.name),
        isCurrent ? el("span", { class: "key-badge" }, "this key") : null,
      ),
      el("td", {}, el("span", { class: "key-mono" }, `jbr_…${k.keyTail}`)),
      el("td", {}, `${k.deviceCount}`),
      el("td", { class: "cell-sub" }, new Date(k.createdAt).toLocaleDateString()),
      el("td", {},
        el("span", { class: "cell-actions" },
          makeKeyCopyBtn(k, false),
          el("button", { class: "ghost-btn", onclick: () => opts.onRenameKey(k) }, "Rename"),
          el("button", { class: "ghost-btn", onclick: () => opts.onRotateKey(k) }, "Rotate"),
          el("button", { class: "ghost-btn danger action-danger action-danger-list", onclick: () => opts.onDeleteKey(k) }, "Delete"),
        ),
      ),
    ));
    keyMobileRows.append(el("div", { class: "m-row" },
      el("div", { class: "m-row-main" },
        el("div", { class: "m-row-title" }, k.name, isCurrent ? el("span", { class: "key-badge" }, "this key") : null),
        el("div", { class: "m-row-sub key-mono" }, `jbr_…${k.keyTail} · ${k.deviceCount} device${k.deviceCount === 1 ? "" : "s"} · ${new Date(k.createdAt).toLocaleDateString()}`),
      ),
      el("div", { class: "m-row-actions" },
        makeKeyCopyBtn(k, true),
        el("button", { class: "m-row-btn", type: "button", title: "Rename", "aria-label": `Rename ${k.name}`, onclick: () => opts.onRenameKey(k) }, icon("pencil", 15)),
        el("button", { class: "m-row-btn", type: "button", title: "Rotate", "aria-label": `Rotate ${k.name}`, onclick: () => opts.onRotateKey(k) }, icon("refresh", 15)),
        el("button", { class: "m-row-btn danger", type: "button", title: "Delete", "aria-label": `Delete ${k.name}`, onclick: () => opts.onDeleteKey(k) }, icon("trash2", 15)),
      ),
    ));
  }
  if (!opts.keys.length) {
    keyTbody.append(el("tr", { class: "static" }, el("td", { colspan: "5", class: "empty-cell" }, "No keys.")));
    keyMobileRows.append(el("div", { class: "m-row m-row-empty" }, "No keys."));
  }
  const keysCard = el("div", { class: "card" },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("keys")),
      el("div", {},
        el("div", { class: "t" }, "API Keys"),
        el("div", { class: "d" }, `${opts.keys.length} keys · devices are grouped by the key they registered with`),
      ),
      el("div", { class: "card-actions" },
        el("button", { class: "ghost-btn action-primary", onclick: () => opts.onCreateKey() }, icon("plus", 12) as unknown as string, "New Key"),
      ),
    ),
  );
  if (opts.freshKey) {
    keysCard.append(el("div", { class: "key-once" },
      el("div", { class: "t" }, `New key “${opts.freshKey.name}” — copy it now, it is shown only once.`),
      el("div", { class: "key-row" },
        el("div", { class: "key-val revealed" }, opts.freshKey.key),
        el("button", {
          class: "ghost-btn",
          onclick: () => void navigator.clipboard?.writeText(opts.freshKey!.key).then(() => { /* copied */ }),
        }, icon("copy", 12) as unknown as string, "Copy"),
        el("button", { class: "ghost-btn", onclick: () => opts.onDismissFreshKey() }, "Done"),
      ),
    ));
  }
  keysCard.append(el("div", { class: "card-body flush" },
    el("div", { class: "card-scroll" },
      el("table", { class: "zebra dev-table" },
        el("thead", {}, el("tr", {},
          el("th", {}, "Name"),
          el("th", { style: "width:130px" }, "Key"),
          el("th", { style: "width:80px" }, "Devices"),
          el("th", { style: "width:110px" }, "Created"),
          el("th", {}, ""),
        )),
        keyTbody,
      ),
      keyMobileRows,
    ),
  ));
  body.append(keysCard);

  // Account card (console credential)
  const userRow = el("input", { class: "account-input", value: opts.account.username, placeholder: "username" }) as HTMLInputElement;
  const passRow = el("input", { class: "account-input", type: "password", placeholder: "New password (min 4 chars, blank = keep)" }) as HTMLInputElement;
  const curRow = el("input", { class: "account-input", type: "password", placeholder: "Current password" }) as HTMLInputElement;
  const accountErr = el("div", { class: "account-err" });
  const saveBtn = el("button", { class: "ghost-btn action-primary" }, "Save") as HTMLButtonElement;
  saveBtn.addEventListener("click", () => {
    accountErr.textContent = "";
    if (!curRow.value) {
      accountErr.textContent = "Enter your current password to confirm.";
      return;
    }
    opts.onChangeAccount(
      curRow.value,
      userRow.value.trim() || undefined,
      passRow.value || undefined,
    );
  });
  body.append(el("div", { class: "card" },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("account")),
      el("div", {},
        el("div", { class: "t" }, "Console Account"),
        el("div", { class: "d" }, "Username and password for this web console"),
      ),
      el("div", { class: "card-actions" }, saveBtn),
    ),
    el("div", { class: "card-body" },
      el("div", { class: "account-rows" }, userRow, passRow, curRow, accountErr),
    ),
  ));

  // Server card
  const kv = el("dl", { class: "kv" });
  if (opts.info) {
    const up = opts.info.uptimeSec;
    const upStr = up > 86400 ? `${Math.floor(up / 86400)}d ${Math.floor((up % 86400) / 3600)}h` : `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
    kv.append(
      el("div", {}, el("dt", {}, "Version"), el("dd", {}, opts.info.version)),
      el("div", {}, el("dt", {}, "Uptime"), el("dd", {}, upStr)),
      el("div", {}, el("dt", {}, "Devices"), el("dd", {}, `${opts.info.devicesOnline} online / ${opts.info.devicesRegistered} registered`)),
      el("div", {}, el("dt", {}, "Viewers"), el("dd", {}, String(opts.info.viewers))),
      el("div", {}, el("dt", {}, "Memory"), el("dd", {}, `${opts.info.rssMB} MB`)),
    );
  } else {
    kv.append(el("div", {}, el("dt", {}, "Status"), el("dd", {}, "loading…")));
  }
  body.append(el("div", { class: "card" },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("relay")),
      el("div", {},
        el("div", { class: "t" }, "Relay Server"),
        el("div", { class: "d" }, location.host),
      ),
    ),
    el("div", { class: "card-body" }, kv),
  ));

  // Devices registry card
  const devTbody = el("tbody");
  const devMobileRows = el("div", { class: "m-rows", "aria-label": "Devices" });
  for (const d of opts.devices) {
    devTbody.append(el("tr", { class: "static" },
      el("td", {}, el("span", { class: `dev-dot${d.online ? " online" : ""}` })),
      el("td", {}, el("div", { class: "cell-title" }, d.name), el("div", { class: "cell-sub" }, `${d.platform} · ${d.version}`)),
      el("td", { class: "cell-sub" }, d.keyName ?? "—"),
      el("td", {}, relTime(d.lastSeen)),
      el("td", {}, el("span", { class: `state-flag${d.blocked ? " blocked" : ""}` }, d.blocked ? "blocked" : "ok")),
      el("td", {},
        el("span", { class: "cell-actions" },
          el("button", { class: d.blocked ? "ghost-btn action-primary" : "ghost-btn", onclick: () => opts.onBlock(d, !d.blocked) }, d.blocked ? "Unblock" : "Block"),
          el("button", { class: "ghost-btn danger action-danger action-danger-list", onclick: () => opts.onRemove(d) }, "Remove"),
        ),
      ),
    ));
    devMobileRows.append(el("div", { class: "m-row" },
      el("span", { class: `dev-dot${d.online ? " online" : ""}` }),
      el("div", { class: "m-row-main" },
        el("div", { class: "m-row-title" }, d.name),
        el("div", { class: "m-row-sub" }, `${d.platform} · ${d.version} · ${d.keyName ?? "—"} · ${relTime(d.lastSeen)}${d.blocked ? " · blocked" : ""}`),
      ),
      el("div", { class: "m-row-actions" },
        el("button", {
          class: "m-row-btn", type: "button",
          title: d.blocked ? "Unblock" : "Block",
          "aria-label": `${d.blocked ? "Unblock" : "Block"} ${d.name}`,
          onclick: () => opts.onBlock(d, !d.blocked),
        }, icon(d.blocked ? "shield" : "shieldOff", 15)),
        el("button", {
          class: "m-row-btn danger", type: "button",
          title: "Remove", "aria-label": `Remove ${d.name}`,
          onclick: () => opts.onRemove(d),
        }, icon("trash2", 15)),
      ),
    ));
  }
  if (!opts.devices.length) {
    devTbody.append(el("tr", { class: "static" }, el("td", { colspan: "6", class: "empty-cell" }, "No devices registered yet.")));
    devMobileRows.append(el("div", { class: "m-row" }, el("div", { class: "m-row-sub" }, "No devices registered yet.")));
  }
  body.append(el("div", { class: "card" },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("devices")),
      el("div", {},
        el("div", { class: "t" }, "Devices"),
        el("div", { class: "d" }, `${opts.devices.length} registered`),
      ),
    ),
    el("div", { class: "card-body flush" },
      el("div", { class: "card-scroll" },
        el("table", { class: "zebra dev-table" },
          el("thead", {}, el("tr", {},
            el("th", { style: "width:44px" }, ""),
            el("th", {}, "Device"),
            el("th", { style: "width:110px" }, "Key"),
            el("th", { style: "width:100px" }, "Last seen"),
            el("th", { style: "width:80px" }, "State"),
            el("th", {}, ""),
          )),
          devTbody,
        ),
        devMobileRows,
      ),
    ),
  ));

  // IP security card (bans + active throttle windows)
  if (opts.security) {
    const fmtWhen = (ts: number): string => {
      const d = new Date(ts);
      const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
      return `${d.toLocaleDateString()} ${hhmm}`;
    };
    const banTbody = el("tbody");
    const banMobileRows = el("div", { class: "m-rows", "aria-label": "Banned IPs" });
    for (const rec of opts.security.bans) {
      const expires = rec.expiresAt > 0 ? fmtWhen(rec.expiresAt) : "permanent";
      banTbody.append(el("tr", { class: "static" },
        el("td", {}, el("span", { class: "key-mono" }, rec.ip)),
        el("td", { class: "cell-sub" }, rec.reason),
        el("td", { class: "cell-sub" }, relTime(rec.bannedAt)),
        el("td", { class: "cell-sub" }, expires),
        el("td", {},
          el("span", { class: "cell-actions" },
            el("button", { class: "ghost-btn action-primary", onclick: () => opts.onUnbanIp?.(rec.ip) }, "Unban"),
          ),
        ),
      ));
      banMobileRows.append(el("div", { class: "m-row" },
        el("div", { class: "m-row-main" },
          el("div", { class: "m-row-title key-mono" }, rec.ip),
          el("div", { class: "m-row-sub" }, `${rec.reason} · until ${expires}`),
        ),
        el("div", { class: "m-row-actions" },
          el("button", {
            class: "m-row-btn", type: "button",
            title: "Unban", "aria-label": `Unban ${rec.ip}`,
            onclick: () => opts.onUnbanIp?.(rec.ip),
          }, icon("x", 15)),
        ),
      ));
    }
    if (!opts.security.bans.length) {
      banTbody.append(el("tr", { class: "static" }, el("td", { colspan: "5", class: "empty-cell" }, "No banned IPs.")));
      banMobileRows.append(el("div", { class: "m-row m-row-empty" }, "No banned IPs."));
    }

    const throttleRows = el("tbody");
    const throttleMobileRows = el("div", { class: "m-rows", "aria-label": "Throttled IPs" });
    for (const snap of opts.security.failures) {
      const state = snap.blockedUntil > 0 ? `locked ${fmtWhen(snap.blockedUntil)}` : `${snap.failures} failures`;
      throttleRows.append(el("tr", { class: "static" },
        el("td", {}, el("span", { class: "key-mono" }, snap.ip)),
        el("td", {}, `${snap.failures}`),
        el("td", {}, `${snap.strikes}`),
        el("td", { class: "cell-sub" }, state),
        el("td", {},
          el("span", { class: "cell-actions" },
            el("button", { class: "ghost-btn action-danger", onclick: () => opts.onBanIp?.(snap.ip) }, "Ban"),
          ),
        ),
      ));
      throttleMobileRows.append(el("div", { class: "m-row" },
        el("div", { class: "m-row-main" },
          el("div", { class: "m-row-title key-mono" }, snap.ip),
          el("div", { class: "m-row-sub" }, `${state} · ${snap.strikes} strike${snap.strikes === 1 ? "" : "s"}`),
        ),
        el("div", { class: "m-row-actions" },
          el("button", {
            class: "m-row-btn danger", type: "button",
            title: "Ban", "aria-label": `Ban ${snap.ip}`,
            onclick: () => opts.onBanIp?.(snap.ip),
          }, icon("shieldOff", 15)),
        ),
      ));
    }

    body.append(el("div", { class: "card" },
      el("div", { class: "card-head" },
        el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("security")),
        el("div", {},
          el("div", { class: "t" }, "Security"),
          el("div", { class: "d" }, `${opts.security.bans.length} banned IP${opts.security.bans.length === 1 ? "" : "s"} · auto-ban after 3 lockouts`),
        ),
        el("span", { class: "spacer" }),
        el("button", { class: "ghost-btn action-primary", onclick: () => opts.onBanIp?.("") }, icon("plus", 12), "Ban IP…"),
      ),
      el("div", { class: "card-body flush" },
        el("div", { class: "card-scroll" },
          el("table", { class: "zebra dev-table" },
            el("thead", {}, el("tr", {},
              el("th", { style: "width:130px" }, "IP"),
              el("th", {}, "Reason"),
              el("th", { style: "width:100px" }, "Banned"),
              el("th", { style: "width:120px" }, "Expires"),
              el("th", {}, ""),
            )),
            banTbody,
          ),
          banMobileRows,
          opts.security.failures.length
            ? el("table", { class: "zebra dev-table", style: "margin-top:10px" },
                el("thead", {}, el("tr", {},
                  el("th", { style: "width:130px" }, "Throttled IP"),
                  el("th", { style: "width:80px" }, "Fails"),
                  el("th", { style: "width:80px" }, "Strikes"),
                  el("th", {}, "State"),
                  el("th", {}, ""),
                )),
                throttleRows,
              )
            : null,
          opts.security.failures.length ? throttleMobileRows : null,
        ),
      ),
    ));
  }

  // Remote Prompts card — full text of everything the console sent to
  // devices, newest first, separate from the summary-only Audit Log.
  const promptTbody = el("tbody");
  const promptMobileRows = el("div", { class: "m-rows", "aria-label": "Remote prompts" });
  for (const p of opts.prompts) {
    const t = new Date(p.ts);
    const hhmmss = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    promptTbody.append(el("tr", { class: "static" },
      el("td", { class: "cell-sub" }, hhmmss),
      el("td", {},
        el("div", { class: "cell-title" }, p.deviceName),
        el("div", { class: "cell-sub" }, p.keyName || "—"),
      ),
      el("td", { class: "cell-sub" }, p.actor),
      el("td", { class: "cell-sub" }, p.action),
      el("td", { class: "cell-prompt" }, p.text),
    ));
    promptMobileRows.append(el("div", { class: "m-row" },
      el("div", { class: "m-row-main" },
        el("div", { class: "m-row-title" }, `${p.deviceName} · ${p.action}`),
        el("div", { class: "m-row-sub" }, `${p.actor}${p.keyName ? ` · ${p.keyName}` : ""} · ${hhmmss}`),
        el("div", { class: "m-row-text" }, p.text),
      ),
    ));
  }
  if (!opts.prompts.length) {
    promptTbody.append(el("tr", { class: "static" }, el("td", { colspan: "5", class: "empty-cell" }, "No remote prompts yet.")));
    promptMobileRows.append(el("div", { class: "m-row m-row-empty" }, "No remote prompts yet."));
  }
  body.append(el("div", { class: "card" },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("prompts")),
      el("div", {},
        el("div", { class: "t" }, "Remote Prompts"),
        el("div", { class: "d" }, "Full text sent from the web console, newest first"),
      ),
    ),
    el("div", { class: "card-body flush" },
      el("div", { class: "card-scroll" },
        el("table", { class: "zebra" },
          el("thead", {}, el("tr", {},
            el("th", { style: "width:80px" }, "Time"),
            el("th", { style: "width:130px" }, "Target"),
            el("th", { style: "width:90px" }, "Source"),
            el("th", { style: "width:150px" }, "Action"),
            el("th", {}, "Prompt"),
          )),
          promptTbody,
        ),
        promptMobileRows,
      ),
    ),
  ));

  // Audit card
  const auditTbody = el("tbody");
  const auditMobileRows = el("div", { class: "m-rows", "aria-label": "Audit log" });
  for (const entry of opts.audit) {
    const t = new Date(entry.ts);
    const hhmmss = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}:${String(t.getSeconds()).padStart(2, "0")}`;
    // Login-security rows (failed attempt / lockout) read as warnings —
    // bright red accent per the danger palette, action + IP stay scannable.
    const isAuthFail = entry.action === "loginFailed" || entry.action === "loginLocked" || entry.action === "authFailed";
    auditTbody.append(el("tr", { class: "static" },
      el("td", {}, hhmmss),
      el("td", {}, entry.actor),
      el("td", { class: isAuthFail ? "cell-danger" : undefined }, entry.action),
      el("td", { class: "cell-sub" }, entry.detail ?? ""),
    ));
    auditMobileRows.append(el("div", { class: "m-row" },
      el("div", { class: "m-row-main" },
        el("div", { class: `m-row-title m-row-title-compact${isAuthFail ? " cell-danger" : ""}` }, `${entry.actor} · ${entry.action}`),
        el("div", { class: "m-row-sub" }, `${hhmmss}${entry.detail ? ` · ${entry.detail}` : ""}`),
      ),
    ));
  }
  if (!opts.audit.length) {
    auditTbody.append(el("tr", { class: "static" }, el("td", { colspan: "4", class: "empty-cell" }, "No activity yet.")));
    auditMobileRows.append(el("div", { class: "m-row m-row-empty" }, "No activity yet."));
  }
  body.append(el("div", { class: "card" },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("audit")),
      el("div", {},
        el("div", { class: "t" }, "Audit Log"),
        el("div", { class: "d" }, "Every remote command, newest first"),
      ),
      el("div", { class: "card-actions" },
        el("button", {
          class: "ghost-btn action-danger", type: "button",
          title: "Clear the audit log", "aria-label": "Clear audit log",
          onclick: () => opts.onClearAudit(),
        }, icon("trash2", 12) as unknown as string, "Clear"),
      ),
    ),
    el("div", { class: "card-body flush" },
      el("div", { class: "card-scroll" },
        el("table", { class: "zebra" },
          el("thead", {}, el("tr", {},
            el("th", { style: "width:80px" }, "Time"),
            el("th", { style: "width:90px" }, "Actor"),
            el("th", { style: "width:140px" }, "Action"),
            el("th", {}, "Detail"),
          )),
          auditTbody,
        ),
        auditMobileRows,
      ),
    ),
  ));
  return body;
}

/**
 * Standalone Devices view: registry list on the left, per-device detail on
 * the right (IP history, UA, remote-op stats from the prompts log).
 */
export interface DeviceMaintenancePanel {
  /** Latest deviceStatus snapshot (null until refreshed on this device). */
  status: {
    supervised?: boolean;
    installDir?: string;
    current?: string | null;
    previous?: string | null;
    releases?: string[];
  } | null;
  /** Form values kept by main.ts so devices-broadcast re-renders keep them. */
  form: {
    source: string;
    sha256: string;
    force: boolean;
    manifestUrl: string;
    version?: string;
    /** Release channel of the selected device (drafts are per channel). */
    channel?: MaintenanceChannel;
  };
  /** checkUpdate in flight (Fetch latest spinner). */
  checking: boolean;
  /** Background manifest check, independent of install progress. */
  releaseCheck?: {
    checkedAt: number | null;
    error: string | null;
    version: string | null;
    keptSelection: boolean;
  };
  /** Ack-pending maintenance action ("restart" | "reboot" | "update" | null). */
  pending: string | null;
  /** Raw-log <details> open state — kept here because progress pushes re-render every ~2s. */
  logOpen: boolean;
  onLogToggle: (open: boolean) => void;
  /** User-controlled folds survive phase changes and status refreshes. */
  openSections?: Partial<Record<"package" | "command" | "installation", boolean>>;
  onSectionToggle?: (section: "package" | "command" | "installation", open: boolean) => void;
  onFormChange: (patch: Partial<DeviceMaintenancePanel["form"]>) => void;
  onRestart: (d: DeviceSummary) => void;
  /** Omit to hide the host-reboot row (desktop devices never expose it). */
  onReboot?: (d: DeviceSummary) => void;
  /** Row copy per platform: agentd restarts a service, desktops restart the app. */
  restartTitle?: string;
  restartHint?: string;
  /** Placeholder for the release field (tarball vs zip/exe). */
  sourcePlaceholder?: string;
  onUpdate: (d: DeviceSummary) => void;
  onCheckUpdate: (d: DeviceSummary) => void;
  onRefreshStatus: (d: DeviceSummary) => void;
  /** Remote shell section (agentd ≥ 1.3.5 only); omit to hide it. */
  exec?: {
    /** Draft command, kept by main.ts so re-renders preserve it. */
    command: string;
    running: boolean;
    /** Latest finished run for the selected device (null = none yet). */
    last: (DeviceExecResult & { command: string; ts: number }) | null;
    onCommandChange: (command: string) => void;
    onRun: (d: DeviceSummary) => void;
  };
}

/**
 * agentd (headless Linux node) detection — kept as the FALLBACK for devices
 * that predate `hello.caps`: they are the only ones that implement the full
 * maintenance surface. Modern clients are gated on capabilities below, since
 * a desktop also ships `maintenance` (update/restart of the app) but never
 * `reboot` (host power) or `exec` (unsandboxed shell).
 */
export function isAgentdDevice(device: DeviceSummary | null): device is DeviceSummary {
  return device !== null && device.platform.startsWith("linux");
}

/**
 * Capability lookup with a platform fallback for devices that never
 * advertised `hello.caps` (agentd < 1.3.1, any desktop < 1.5.2).
 */
export function hasDeviceCap(device: DeviceSummary | null, cap: string): boolean {
  if (!device) return false;
  const caps = device.caps;
  if (Array.isArray(caps) && caps.length > 0) return caps.includes(cap);
  // Legacy devices: only the linux headless node had any of these features.
  return isAgentdDevice(device);
}

/** Remote update / restart-of-process available (agentd and desktop ≥ 1.5.2). */
export function supportsMaintenance(device: DeviceSummary | null): boolean {
  return hasDeviceCap(device, "maintenance");
}

/** Host reboot — agentd only; desktops never advertise it. */
export function supportsReboot(device: DeviceSummary | null): boolean {
  return hasDeviceCap(device, "reboot");
}

/** Sandboxed remote shell — agentd only. */
export function supportsExec(device: DeviceSummary | null): boolean {
  return hasDeviceCap(device, "exec");
}

const MAINT_PHASE_LABEL: Record<DeviceMaintenanceState["phase"], string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Updating",
  done: "Done",
  failed: "Failed",
};

/** No timestamp refresh for this long → treat the phase as stuck and unlock. */
const MAINT_STALE_MS = 90_000;

function maintenanceProgressStale(live: DeviceMaintenanceState | null): boolean {
  if (!live || (live.phase !== "queued" && live.phase !== "running")) return false;
  if (typeof live.ts !== "number" || !Number.isFinite(live.ts)) return true;
  return Date.now() - live.ts > MAINT_STALE_MS;
}

/* ── Fine-grained update progress (agentd ≥ 1.4) ────────────────────
   The device reports granular step ids (download/verify/extract/smoke/
   install/switch/units/restart); the card collapses them into five UI
   buckets so the track stays readable at device-panel width. Older
   devices send no step — the card falls back to the raw logTail view. */
const MAINT_STEP_BUCKETS = ["Download", "Verify", "Extract", "Install", "Restart"] as const;
const MAINT_STEP_ONGOING = ["Downloading", "Verifying", "Extracting", "Installing", "Restarting"] as const;
const MAINT_STEP_BUCKET: Record<string, number> = {
  download: 0,
  verify: 1,
  extract: 2,
  smoke: 2,
  install: 3,
  switch: 3,
  units: 3,
  restart: 4,
};

function fmtMaintMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Stepper: done buckets check-green, the live one spins, a failed phase marks its bucket red. */
function buildMaintStepTrack(live: DeviceMaintenanceState, bucketIdx: number): HTMLElement {
  const done = live.phase === "done";
  const failed = live.phase === "failed";
  const track = el("div", {
    class: "maint-steps",
    role: "list",
    "aria-label": `Update steps — ${MAINT_STEP_BUCKETS.map((label, i) =>
      `${label} ${done || i < bucketIdx ? "done" : i === bucketIdx ? (failed ? "failed" : "in progress") : "pending"}`,
    ).join(", ")}`,
  });
  MAINT_STEP_BUCKETS.forEach((label, i) => {
    const state = done || i < bucketIdx ? "is-done" : i === bucketIdx ? (failed ? "is-failed" : "is-current") : "";
    const dot = el("span", { class: "maint-step-dot" });
    if (state === "is-done") {
      dot.append(el("span", { class: "maint-step-glyph", "aria-hidden": "true" }, icon("check", 9)));
    } else if (state === "is-current") {
      dot.append(el("span", { class: "spinner", "aria-hidden": "true" }));
    } else if (state === "is-failed") {
      dot.append(el("span", { class: "maint-step-glyph", "aria-hidden": "true" }, icon("x", 9)));
    }
    track.append(
      el("div", { class: `maint-step${state ? " " + state : ""}`, role: "listitem" },
        dot,
        el("span", { class: "maint-step-label" }, label),
      ),
    );
  });
  return track;
}

/** Byte-level download bar — determinate with Content-Length, glide without. */
function buildMaintProgressRow(live: DeviceMaintenanceState): HTMLElement | null {
  if (live.phase !== "running" || live.step !== "download") return null;
  const p = live.progress;
  if (!p || typeof p.receivedBytes !== "number") return null;
  const fill = el("div", {
    class: `maint-progress-fill${typeof p.pct === "number" ? "" : " is-indet"}`,
    ...(typeof p.pct === "number" ? { style: `width:${p.pct}%` } : {}),
  });
  const label = `${fmtMaintMb(p.receivedBytes)}${typeof p.totalBytes === "number" ? ` / ${fmtMaintMb(p.totalBytes)}` : ""}`;
  const rate = typeof p.bytesPerSec === "number" ? `${fmtMaintMb(p.bytesPerSec)}/s` : "";
  return el("div", { class: "maint-progress" },
    el("div", {
      class: "maint-progress-bar", role: "progressbar", "aria-label": "Download progress",
      "aria-valuemin": "0", "aria-valuemax": "100",
      ...(typeof p.pct === "number" ? { "aria-valuenow": String(p.pct) } : {}),
    }, fill),
    el("div", { class: "maint-progress-meta" },
      el("span", { class: "maint-progress-label mono" }, label),
      el("span", { class: "maint-progress-rate mono" }, rate),
    ),
  );
}

/* ── Progress-tick re-render gate ───────────────────────────────────
   During an update the device pushes maintenance state every ~2s; each
   push used to rebuild the WHOLE devices view (replaceChildren), which
   recreated the scrolling .dev-detail column and yanked the page back to
   the top. When a devices broadcast differs from the previous one only
   by volatile maintenance fields (progress / ts / logTail) or bookkeeping
   timestamps, the console patches the maintenance card's chip + live
   zone in place instead — DOM identity, scroll, and focus survive. */

/** Strip fields that may change on every ~2s progress push without any
 *  structural effect on the devices view (rendered values get patched). */
function stripMaintenanceVolatile(device: DeviceSummary): DeviceSummary {
  const maintenance = device.maintenance;
  if (!maintenance) return { ...device, lastSeen: 0, ipHistory: undefined };
  const { progress: _progress, ts: _ts, logTail: _logTail, ...stable } = maintenance;
  return {
    ...device,
    // Bookkeeping timestamps move on every push — not structural.
    lastSeen: 0,
    ipHistory: undefined,
    maintenance: stable as DeviceMaintenanceState,
  };
}

/** True when the only difference between two devices broadcasts is
 *  progress-tick noise — the caller may patch in place instead of a
 *  full view re-render. Any structural change (device set, online,
 *  version, phase, step, …) returns false. */
export function isMaintenanceTickOnly(
  prev: DeviceSummary[],
  next: DeviceSummary[],
): boolean {
  if (prev.length !== next.length) return false;
  return next.every((device, i) => {
    const before = prev[i]!;
    return (
      device.deviceId === before.deviceId &&
      JSON.stringify(stripMaintenanceVolatile(device)) ===
        JSON.stringify(stripMaintenanceVolatile(before))
    );
  });
}

function maintenanceBusy(live: DeviceMaintenanceState | null): boolean {
  const stale = maintenanceProgressStale(live);
  return (live?.phase === "queued" || live?.phase === "running") && !stale;
}

/** Chip text — separated from the builder so progress ticks can rewrite the
 *  text node in place instead of rebuilding the chip (a rebuilt spinner
 *  element would restart its rotation animation on every ~2s push). */
function maintenanceChipText(live: DeviceMaintenanceState | null): string {
  const stale = maintenanceProgressStale(live);
  const busy = maintenanceBusy(live);
  const livePhase = live?.phase ?? "idle";
  const chipBase = busy
    ? live?.source === "reboot"
      ? "Rebooting"
      : live?.step === "download" && typeof live.progress?.pct === "number"
        ? `Updating · ${live.progress.pct}%`
        : MAINT_PHASE_LABEL[livePhase]
    : MAINT_PHASE_LABEL[livePhase];
  return `${chipBase}${stale ? " · stalled" : ""}${live?.version && live.phase === "done" ? ` · ${live.version}` : ""}`;
}

/** Visual-state signature of the chip: while it holds between ticks, only
 *  the text node needs patching — class set, spinner presence, and label
 *  verb all stay put (any of them changing → shape differs → full rebuild). */
function maintenanceChipShape(live: DeviceMaintenanceState | null): string {
  if (!live) return "none";
  const stale = maintenanceProgressStale(live);
  const busy = (live.phase === "queued" || live.phase === "running") && !stale;
  return [
    live.phase,
    busy ? "busy" : "-",
    stale ? "stale" : "-",
    live.source === "reboot" ? "reboot" : "-",
    live.step === "download" && typeof live.progress?.pct === "number" ? "pct" : "-",
    live.version && live.phase === "done" ? "ver" : "-",
  ].join("|");
}

/** The card-head phase chip (Updating · N% / Rebooting / Done · x / Failed). */
export function buildMaintenanceChip(live: DeviceMaintenanceState | null): HTMLElement {
  const busy = maintenanceBusy(live);
  return el("span", {
    class: `maint-chip${live?.phase === "failed" ? " is-failed" : ""}${busy ? " is-busy" : ""}${live?.phase === "done" ? " is-done" : ""}`,
    "data-maint-shape": maintenanceChipShape(live),
  },
    ...(busy ? [el("span", { class: "spinner maint-spinner", "aria-hidden": "true" })] : []),
    maintenanceChipText(live),
  );
}

/** Structural signature of the live zone. Progress VALUES are volatile and
 *  excluded — while the shape holds, a tick patches only text/width in
 *  place; any drift (phase/step/error/stale/log/…) falls back to a zone
 *  rebuild. */
function maintenanceZoneShape(live: DeviceMaintenanceState | null, panel: DeviceMaintenancePanel): string {
  if (!live || live.phase === "idle") {
    return `idle|${panel.form.source.trim() ? "src" : "empty"}`;
  }
  const bucketIdx = live.step !== undefined ? MAINT_STEP_BUCKET[live.step] : undefined;
  const showBar = live.phase === "running" && live.step === "download" &&
    !!live.progress && typeof live.progress.receivedBytes === "number";
  return [
    live.phase,
    live.source === "reboot" ? "reboot" : "update",
    bucketIdx ?? "-",
    live.error ? "err" : "-",
    maintenanceProgressStale(live) ? "stale" : "-",
    live.source ? "src" : "-",
    showBar ? (typeof live.progress?.pct === "number" ? "det" : "indet") : "-",
    live.logTail ? (bucketIdx !== undefined ? "logf" : "logr") : "-",
    live.ts ? "ts" : "-",
  ].join("|");
}

/** Rewrite only the volatile bits of a shape-stable live zone: download bar
 *  width (+ aria), byte/rate caption, percent/relative-time caption, and
 *  the log tail. Element identity is preserved throughout — the stepper
 *  spinner keeps rotating and the fill's width transition glides instead of
 *  restarting on a rebuilt node. */
function patchMaintenanceZoneVolatile(zone: HTMLElement, live: DeviceMaintenanceState): void {
  const p = live.progress;
  if (live.phase === "running" && live.step === "download" && p && typeof p.receivedBytes === "number") {
    if (typeof p.pct === "number") {
      const fill = zone.querySelector<HTMLElement>(".maint-progress-fill");
      if (fill) fill.style.width = `${p.pct}%`;
      zone.querySelector<HTMLElement>(".maint-progress-bar")?.setAttribute("aria-valuenow", String(p.pct));
    }
    const label = zone.querySelector<HTMLElement>(".maint-progress-label");
    if (label) {
      label.textContent = `${fmtMaintMb(p.receivedBytes)}${typeof p.totalBytes === "number" ? ` / ${fmtMaintMb(p.totalBytes)}` : ""}`;
    }
    const rate = zone.querySelector<HTMLElement>(".maint-progress-rate");
    if (rate) rate.textContent = typeof p.bytesPerSec === "number" ? `${fmtMaintMb(p.bytesPerSec)}/s` : "";
  }
  const pctEl = zone.querySelector<HTMLElement>(".maint-percent");
  if (pctEl && typeof p?.pct === "number") pctEl.textContent = `${p.pct}%`;
  const timeEl = zone.querySelector<HTMLElement>(".maint-time");
  if (timeEl && live.ts) timeEl.textContent = relTime(live.ts);
  const log = zone.querySelector<HTMLElement>(".maint-log");
  if (log && live.logTail) log.textContent = live.logTail;
}

/** The live block in the update section: phase row, download progress,
 *  bar, error line, collapsed output log, stale hint. Wrapped in one zone
 *  so progress ticks patch THIS subtree alone. */
export function buildMaintenanceLiveZone(
  live: DeviceMaintenanceState | null,
  panel: DeviceMaintenancePanel,
): HTMLElement {
  const zone = el("div", { class: "maint-live-zone" });
  zone.dataset.maintShape = maintenanceZoneShape(live, panel);
  if (!live || live.phase === "idle") {
    if (!panel.form.source.trim()) {
      zone.append(el("div", { class: "maint-notice" }, icon("circleAlert", 14),
        el("span", {}, "Fetch the latest release, or open the package settings to enter a source manually.")));
    }
    return zone;
  }
  const busy = maintenanceBusy(live);
  const bucketIdx = live.step !== undefined ? MAINT_STEP_BUCKET[live.step] : undefined;
  // Live-row label mirrors the chip: Rebooting / step verb / phase name.
  const phaseText = busy
    ? live.source === "reboot"
      ? "Rebooting"
      : bucketIdx !== undefined
        ? MAINT_STEP_ONGOING[bucketIdx]
        : MAINT_PHASE_LABEL[live.phase]
    : MAINT_PHASE_LABEL[live.phase];
  const operation = live.source === "reboot" ? "Reboot" : "Update";
  const liveRow = el("div", { class: "maint-live" },
    el("span", { class: "maint-phase cell-sub" },
      live.phase === "done" ? `${operation} complete` : live.phase === "failed" ? `${operation} failed` : phaseText),
  );
  if (live.step === "download" && typeof live.progress?.pct === "number" && live.phase === "running") {
    liveRow.append(el("span", { class: "maint-percent" }, `${live.progress.pct}%`));
  } else if (live.ts) {
    liveRow.append(el("span", { class: "maint-time" }, relTime(live.ts)));
  }
  zone.append(liveRow);
  if (live.error) {
    zone.append(el("div", { class: "maint-error", role: "alert" }, icon("warn", 12), el("span", {}, live.error)));
  }
  if (maintenanceProgressStale(live)) {
    zone.append(el("div", { class: "maint-notice is-warning", role: "alert" }, icon("warn", 14),
      el("span", {}, "No progress for 90 seconds — actions unlocked. Check the log or restart the service if needed.")));
  }
  if (live.source) {
    zone.append(el("div", { class: "maint-src mono", title: live.source },
      live.source.split("/").pop() ?? live.source));
  }
  const progressRow = buildMaintProgressRow(live);
  if (progressRow) zone.append(progressRow);
  if (bucketIdx !== undefined && (live.phase === "running" || live.phase === "done" || live.phase === "failed")) {
    zone.append(buildMaintStepTrack(live, bucketIdx));
  }
  if (live.logTail) {
    if (bucketIdx !== undefined) {
      // New agentd: the stepper carries the story; the raw log demotes
      // behind a collapsed toggle (open state survives progress re-renders).
      const details = el("details", {
        class: "maint-logwrap",
        ...(panel.logOpen ? { open: true } : {}),
      });
      details.addEventListener("toggle", () => {
        if (details.isConnected) panel.onLogToggle(details.open);
      });
      details.append(
        el("summary", {},
          el("span", { class: "chev", "aria-hidden": "true" }, icon("chevronRight", 11)),
          "Output log",
        ),
        el("pre", { class: "maint-log mono" }, live.logTail),
      );
      zone.append(details);
    } else {
      // Legacy agentd (< 1.4): logTail is all there is — keep it visible.
      zone.append(el("pre", { class: "maint-log mono" }, live.logTail));
    }
  }
  return zone;
}

/** Patch a rendered maintenance card with fresh live state WITHOUT
 *  rebuilding the view. Shape-unchanged ticks rewrite only text nodes and
 *  the progress width in place — spinner elements, the step track, and the
 *  fill's width transition keep running instead of restarting on rebuilt
 *  nodes (that restart is what made the update animation stutter every
 *  ~2s push). Shape changes (phase/step/error/stale/…) still replace the
 *  chip/zone wholesale. Returns false when the card (or its zone) is not
 *  on screen. */
export function patchMaintenanceLive(
  view: HTMLElement,
  live: DeviceMaintenanceState | null,
  panel: DeviceMaintenancePanel,
): boolean {
  const card = view.querySelector<HTMLElement>(".maint-card");
  const chip = card?.querySelector<HTMLElement>(".maint-chip");
  const zone = card?.querySelector<HTMLElement>(".maint-live-zone");
  if (!card || !chip || !zone) return false;
  if (chip.dataset.maintShape === maintenanceChipShape(live)) {
    // Same visual state → swap only the text node, keep the spinner element
    // (and its rotation animation) alive.
    const textNode = [...chip.childNodes].reverse().find((n) => n.nodeType === 3);
    const text = maintenanceChipText(live);
    if (textNode) textNode.textContent = text;
    else chip.append(document.createTextNode(text));
  } else {
    chip.replaceWith(buildMaintenanceChip(live));
  }
  if (zone.dataset.maintShape === maintenanceZoneShape(live, panel)) {
    if (live) patchMaintenanceZoneVolatile(zone, live);
  } else {
    zone.replaceWith(buildMaintenanceLiveZone(live, panel));
  }
  return true;
}

/** Live-chip + action form for agentd remote maintenance (restart/update/reboot). */
function buildMaintenanceCard(selected: DeviceSummary, panel: DeviceMaintenancePanel): HTMLElement {
  const live = selected.maintenance ?? null;
  const busy = maintenanceBusy(live);
  const kv = (label: string, value: Node | string): HTMLElement =>
    el("div", {}, el("dt", {}, label), el("dd", {}, value));

  const chip = buildMaintenanceChip(live);

  const online = selected.online;
  const pending = panel.pending;
  const actionsLocked = !online || busy || pending !== null;
  const formLocked = actionsLocked || panel.checking;
  let sourceVersion = panel.form.version;
  const fold = (
    section: "package" | "command" | "installation", label: string, context: Node | string, content: HTMLElement,
  ): HTMLDetailsElement => {
    const details = el("details", {
      class: `maint-fold maint-${section}`, "data-maint-section": section,
      ...(panel.openSections?.[section] ? { open: true } : {}),
    },
      el("summary", {},
        el("span", { class: "maint-fold-chevron", "aria-hidden": "true" }, icon("chevronRight", 12)),
        el("span", { class: "maint-fold-label" }, label),
        el("span", { class: "maint-fold-context" }, context),
      ), content,
    );
    details.addEventListener("toggle", () => {
      if (details.isConnected) panel.onSectionToggle?.(section, details.open);
    });
    return details;
  };
  const restartBtn = el("button", {
    class: "ghost-btn maint-restart-btn maint-device-btn", type: "button",
    disabled: actionsLocked,
    "aria-busy": String(pending === "restart"),
    title: panel.restartTitle ?? "Restart the JellyBot agent service (systemd revives it)",
    onclick: () => panel.onRestart(selected),
  }, icon("refresh", 13), "Restart");
  const rebootBtn = panel.onReboot
    ? el("button", {
        class: "ghost-btn danger maint-reboot-btn maint-device-btn", type: "button",
        disabled: actionsLocked,
        "aria-busy": String(pending === "reboot"),
        title: "Reboot the device host (root helper installed with the updater)",
        onclick: () => panel.onReboot!(selected),
      }, icon("power", 13), "Reboot")
    : null;
  const refreshBtn = el("button", {
    class: "ghost-btn maint-refresh-btn", type: "button",
    disabled: !online,
    title: "Refresh install details from the device",
    onclick: () => panel.onRefreshStatus(selected),
  }, icon("history", 13), "Refresh details");

  const sourceInput = el("input", {
    class: "ws-input mono",
    type: "text",
    value: panel.form.source,
    placeholder: panel.sourcePlaceholder ?? "https://…/jellybot-agentd-<version>-linux-arm64.tar.gz",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Release tarball URL or device path",
    "data-maint-field": "source", disabled: formLocked,
  }) as HTMLInputElement;
  sourceInput.addEventListener("input", () => {
    sourceVersion = undefined;
    panel.onFormChange({ source: sourceInput.value, version: undefined });
    syncRelease();
  });
  const shaInput = el("input", {
    class: "ws-input mono",
    type: "text",
    value: panel.form.sha256,
    placeholder: "sha256 (64 hex — required for URLs)",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Release sha256",
    "data-maint-field": "sha256", disabled: formLocked,
  }) as HTMLInputElement;
  shaInput.addEventListener("input", () => {
    panel.onFormChange({ sha256: shaInput.value });
    syncRelease();
  });
  const manifestInput = el("input", {
    class: "ws-input mono",
    type: "text",
    value: panel.form.manifestUrl,
    placeholder: "downloads.json URL",
    spellcheck: "false",
    autocomplete: "off",
    "aria-label": "Downloads manifest URL",
    "data-maint-field": "manifestUrl", disabled: formLocked,
  }) as HTMLInputElement;
  manifestInput.addEventListener("input", () => panel.onFormChange({ manifestUrl: manifestInput.value }));

  const forceBox = el("input", {
    class: "maint-check",
    type: "checkbox",
    ...(panel.form.force ? { checked: "" } : {}),
    "aria-label": "Force reinstall of the same version",
    "data-maint-field": "force", disabled: formLocked,
  }) as HTMLInputElement;
  forceBox.addEventListener("change", () => {
    panel.onFormChange({ force: forceBox.checked });
    syncRelease();
  });

  const checkBtn = el("button", {
    class: "ghost-btn maint-check-btn", type: "button",
    disabled: formLocked,
    // Channel-explicit: the manifest carries one entry per platform, and the
    // device resolves the one that matches its own platform.
    title: `Read the ${panel.form.channel ?? "device"} entry of the manifest from the device and fill URL + sha256`,
    onclick: () => panel.onCheckUpdate(selected),
  },
    // Spinner only while the manifest read is in flight (idle = plain button).
    ...(panel.checking ? [el("span", { class: "spinner maint-spinner", "aria-hidden": "true" })] : []),
    "Fetch latest");
  const updateBtn = el("button", {
    class: "btn primary maint-update-btn action-primary", type: "button",
    disabled: actionsLocked,
    "aria-busy": String(pending === "update" || busy),
    title: "Install the selected release on the device",
    onclick: () => panel.onUpdate(selected),
  }, icon("download", 13), "Update");

  const versionSummary = el("div", { class: "maint-version-summary" });
  const packageSummary = el("span", { class: "mono" });
  const reinstallHint = el("div", { class: "maint-reinstall-hint cell-sub" });
  function syncRelease(): void {
    const draftSource = sourceInput.value.trim();
    const source = busy && live?.source && live.source !== "reboot" ? live.source : draftSource;
    const filenameOf = (value: string): string => value.split(/[?#]/)[0]!.split("/").pop() ?? value;
    const filename = filenameOf(source);
    // Version comes from the manifest (Fetch latest, per channel) or from the
    // release filename itself — agentd tarball, mac zip/dmg or win setup. A
    // desktop package used to fall through to "no version", which then made
    // the same-version guard read another platform's version.
    const version = (source === draftSource ? sourceVersion : undefined)
      || releaseVersionFromFile(filename);
    const sameVersion = !!version && version.replace(/^v/, "") === selected.version.replace(/^v/, "");
    const validSource = !!source && (!/^https?:\/\//i.test(source) || /^[a-f\d]{64}$/i.test(shaInput.value.trim()));
    const versions = el("div", { class: "maint-version-line" });
    if (version && !sameVersion) {
      versions.append(el("span", { class: "maint-current-version" }, selected.version),
        el("span", { class: "maint-version-arrow", "aria-hidden": "true" }, "→"), el("span", {}, version));
    } else {
      versions.append(el("span", {}, selected.version));
    }
    versionSummary.replaceChildren(el("div", { class: "maint-update-caption" }, "Software update"), versions,
      el("div", { class: "maint-version-meta cell-sub" },
        source ? `${selected.platform} · ${busy && live?.source !== "reboot" ? "Updating release" : "Selected release"}${version ? "" : `: ${filename}`}` : `Current version · ${selected.platform}`));
    packageSummary.textContent = filenameOf(draftSource) || "No release selected";
    packageSummary.title = draftSource;
    reinstallHint.textContent = "This version is already installed. Enable Force reinstall in the package settings to install it again.";
    reinstallHint.hidden = !sameVersion || forceBox.checked || busy;
    updateBtn.disabled = formLocked || !validSource || (sameVersion && !forceBox.checked);
    const label = busy && live?.source !== "reboot"
      ? live?.step === "download" ? "Downloading…" : live?.phase === "queued" ? "Queued…" : "Updating…"
      : sameVersion ? "Reinstall" : "Update";
    updateBtn.replaceChildren(el("span", { class: "maint-button-icon", "aria-hidden": "true" }, icon("download", 13)), document.createTextNode(label));
  }
  syncRelease();

  const updateSection = el("div", { class: "maint-update-section" },
    el("div", { class: "maint-update-top" }, versionSummary,
      el("div", { class: "maint-update-actions" }, checkBtn, updateBtn)),
    reinstallHint,
  );
  const check = panel.releaseCheck;
  if (panel.checking || check?.error || check?.version) {
    const note = panel.checking ? "Checking latest release…"
      : check?.error ? `Could not check latest: ${check.error}`
      : `Latest release: ${check!.version}${check?.checkedAt ? ` · checked ${new Date(check.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}${check?.keptSelection ? " · Your selected package was kept." : ""}`;
    updateSection.append(el("div", {
      class: "maint-check-note cell-sub", role: "status", "aria-live": "polite",
    }, note));
  }
  if (!online) {
    updateSection.append(el("div", { class: "maint-notice" }, icon("circleAlert", 14),
      "Device offline — maintenance needs the device connected."));
  }
  updateSection.append(buildMaintenanceLiveZone(live, panel));
  const body = el("div", { class: "card-body maint-body" }, updateSection,
    fold("package", "Package & update source", packageSummary, el("div", { class: "maint-fold-body maint-form" },
      el("label", { class: "maint-field" },
        el("span", { class: "maint-label" }, "Release URL / device path"),
        sourceInput,
      ),
      el("label", { class: "maint-field" },
        el("span", { class: "maint-label" }, "SHA-256"),
        shaInput,
      ),
      el("label", { class: "maint-field" },
        el("span", { class: "maint-label" }, "Downloads manifest"),
        manifestInput,
      ),
      el("label", { class: "maint-force" }, forceBox, "Force reinstall of the same version"),
      el("div", { class: "cell-sub" }, "URL sources require a SHA-256 checksum. Fetch latest fills it from the release manifest."),
    )),
    el("section", { class: "maint-device-controls maint-actions" },
      el("div", { class: "maint-section-caption" }, "Device controls"),
      el("div", { class: "maint-service-row" },
        el("div", { class: "maint-service-copy" }, el("div", {}, panel.restartHint ?? "Restart agent service"),
          el("div", { class: "cell-sub" }, "Restart JellyBot. The service reconnects automatically.")), restartBtn),
      ...(rebootBtn
        ? [
            el("div", { class: "maint-service-row" },
              el("div", { class: "maint-service-copy" }, el("div", {}, "Reboot device"),
                el("div", { class: "cell-sub" }, "Restart the host. The device will be offline briefly.")), rebootBtn),
          ]
        : []),
    ),
  );

  // ── Remote shell (agentd ≥ 1.3.5) ──────────────────────────────
  if (panel.exec) {
    const exec = panel.exec;
    const runBtn = el("button", {
      class: "ghost-btn maint-exec-run action-primary", type: "button",
      disabled: !online || exec.running || exec.command.trim() === "",
      "aria-busy": String(exec.running),
      title: "Run the command on the device (⌘/Ctrl+Enter)",
      onclick: () => exec.onRun(selected),
    },
      ...(exec.running ? [el("span", { class: "spinner maint-spinner", "aria-hidden": "true" })] : []),
      icon("terminal", 13), "Run");
    const cmdInput = el("textarea", {
      class: "ws-input mono maint-exec-input",
      rows: "2",
      placeholder: "shell command — runs as the agent service user (sandboxed, no sudo)",
      spellcheck: "false",
      "aria-label": "Command to run on the device",
      "data-maint-field": "command",
    }) as HTMLTextAreaElement;
    cmdInput.value = exec.command;
    cmdInput.addEventListener("input", () => {
      exec.onCommandChange(cmdInput.value);
      // Typing must not trigger a re-render (cursor jump), so keep the Run
      // button's disabled state in sync live — it was computed from the
      // (initially empty) draft at render time.
      runBtn.disabled = !online || exec.running || cmdInput.value.trim() === "";
    });
    cmdInput.addEventListener("keydown", (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === "Enter" && !runBtn.disabled) {
        ev.preventDefault();
        exec.onRun(selected);
      }
    });
    const execSection = el("div", { class: "maint-fold-body maint-exec" },
      el("span", { class: "maint-label" }, "Command"),
      cmdInput,
      el("div", { class: "maint-form-actions" },
        el("span", { class: "cell-sub maint-exec-hint" }, "30s timeout · 256KB output cap · one at a time"),
        runBtn,
      ),
    );
    const last = exec.last;
    if (last) {
      const head = `$ ${last.command}\nexit ${last.exitCode === null ? "—" : String(last.exitCode)} · ${last.durationMs}ms${last.timedOut ? " · TIMED OUT" : ""}${last.truncated ? " · TRUNCATED" : ""} · ${relTime(last.ts)}`;
      const text = [
        head,
        last.stdout ? `\n${last.stdout.replace(/\n+$/, "")}` : "",
        last.stderr ? `\n— stderr —\n${last.stderr.replace(/\n+$/, "")}` : "",
      ].join("");
      execSection.append(el("pre", { class: "maint-log mono maint-exec-out" }, text));
    }
    body.append(fold("command", "Run command", "Remote shell", execSection));
  }

  const installation = el("div", { class: "maint-fold-body" });
  if (panel.status) {
    const currentName = panel.status.current?.split("/").pop() ?? panel.status.current ?? "—";
    const prevName = panel.status.previous?.split("/").pop() ?? panel.status.previous ?? "—";
    installation.append(el("dl", { class: "kv maint-kv" },
      kv("Supervised", panel.status.supervised ? "systemd" : "no (manual run)"),
      kv("Current", currentName), kv("Previous", prevName),
      kv("Releases", (panel.status.releases ?? []).join(" · ") || "—"),
    ));
  } else {
    installation.append(el("div", { class: "cell-sub maint-install-hint" }, "Refresh to read the installation details from the device."));
  }
  installation.append(refreshBtn);
  body.append(fold("installation", "Installation details",
    panel.status ? `${panel.status.supervised ? "systemd" : "manual run"} · ${selected.version}` : "Not refreshed", installation));

  return el("div", { class: "card maint-card", "data-device-id": selected.deviceId },
    el("div", { class: "card-head" },
      el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("maintenance")),
      el("div", {},
        el("div", { class: "t" }, "Maintenance"),
        el("div", { class: "d" }, "Software update & device controls"),
      ),
      chip,
    ),
    body,
  );
}

/**
 * CoCo entry gate — one rule for every entry point (desktop sidebar device
 * row + the device card action phones rely on): the device advertised the
 * `coco` cap and is online.
 */
export function deviceCocoReady(d: DeviceSummary): boolean {
  return d.online && (d.caps ?? []).includes("coco");
}

/** Why the tile can't go straight to the device the home selector shows. */
export type CocoEntryBlocked = "offline" | "unsupported" | "none" | null;

export interface CocoEntryState {
  /** Some device can host CoCo (no candidate → the tile is not rendered). */
  visible: boolean;
  /**
   * The device a tap opens **without asking** — only ever the device the home
   * selector shows. Another device is never opened behind the user's back:
   * a selection that can't host CoCo leaves this null.
   */
  direct: string | null;
  /** CoCo-capable devices in list order (the sheet's rows). */
  devices: DeviceSummary[];
  /** Any candidate has running sessions (the tile's activity dot). */
  busy: boolean;
  /** Why `direct` is null, for the sheet's hint line. */
  blocked: CocoEntryBlocked;
}

/**
 * Mobile home CoCo entry — always bound to the device the selector shows.
 *
 * An earlier revision opened the single CoCo-capable device even when another
 * device was selected, which read as "the tile ignores my device and always
 * lands on that one". Selection now decides: same device or an explicit pick.
 */
export function cocoEntryState(
  devices: DeviceSummary[],
  selectedId: string | null,
): CocoEntryState {
  const ready = devices.filter(deviceCocoReady);
  if (!ready.length) {
    return { visible: false, direct: null, devices: [], busy: false, blocked: null };
  }
  const selected = selectedId ? devices.find((d) => d.deviceId === selectedId) ?? null : null;
  const direct = selected && deviceCocoReady(selected) ? selected.deviceId : null;
  const blocked: CocoEntryBlocked = direct
    ? null
    : !selected
      ? "none"
      : (selected.caps ?? []).includes("coco")
        ? "offline"
        : "unsupported";
  return {
    visible: true,
    direct,
    devices: ready,
    busy: ready.some((d) => (d.runningSessions ?? 0) > 0),
    blocked,
  };
}

export function renderDevicesViewBody(opts: {
  devices: DeviceSummary[];
  prompts: PromptLogEntry[];
  selectedId: string | null;
  onSelect: (d: DeviceSummary) => void;
  onBlock: (d: DeviceSummary, blocked: boolean) => void;
  onRemove: (d: DeviceSummary) => void;
  /** Open the CoCo workspace for one device (entry lives on the identity card). */
  onOpenCoco?: (d: DeviceSummary) => void;
  /** Mobile only: opens the device-picker bottom sheet. */
  onOpenPicker?: () => void;
  /** Remote maintenance panel (agentd ≥ 1.3.1); omit to hide the card. */
  maintenance?: DeviceMaintenancePanel;
  /** Feature-owned card mounted below identity (Token Hub interaction demo). */
  providerManagementCard?: HTMLElement;
  mcpManagementCard?: HTMLElement;
  skillManagementCard?: HTMLElement;
}): HTMLElement {
  const selected = opts.devices.find((d) => d.deviceId === opts.selectedId) ?? null;
  const body = el("div", { class: "devices-body" });

  // Mobile-only dropdown selector (CSS hides it on desktop, where the
  // registry list card on the left does the same job).
  const picked = selected ?? opts.devices[0] ?? null;
  body.append(el("button", {
    class: "dev-picker", type: "button",
    "aria-haspopup": "listbox", "aria-expanded": "false",
    title: "Device", "aria-label": "Pick device",
    onclick: (event) => {
      event.stopPropagation();
      opts.onOpenPicker?.();
    },
  },
    el("span", { class: `dev-dot${picked?.online ? " online" : ""}` }),
    el("span", { class: "m-select-value" }, picked?.name ?? "No devices"),
    el("span", { class: "m-select-chevron" }, icon("chevronDown", 13)),
  ));

  // ── left: registry list ──
  const listScroll = el("div", { class: "card-scroll" });
  for (const d of opts.devices) {
    const busy = d.online && (d.runningSessions ?? 0) > 0;
    listScroll.append(el("button", {
      class: `dev-row${d.deviceId === opts.selectedId ? " selected" : ""}`,
      type: "button",
      "aria-pressed": d.deviceId === opts.selectedId ? "true" : "false",
      onclick: () => opts.onSelect(d),
    },
      el("span", { class: `dev-dot${d.online ? " online" : ""}${busy ? " busy" : ""}` }),
      el("span", { class: "dev-row-main" },
        el("span", { class: "dev-row-name" }, d.name),
        el("span", { class: "dev-row-sub" }, `${d.platform} · ${d.version} · ${d.keyName ?? "—"}`),
      ),
      el("span", { class: "dev-row-state" }, d.blocked ? "blocked" : d.online ? "online" : "offline"),
    ));
  }
  if (!opts.devices.length) {
    listScroll.append(el("div", { class: "empty-cell", style: "padding:18px 16px" }, "No devices registered yet."));
  }
  const onlineCount = opts.devices.filter((d) => d.online).length;
  body.append(el("div", { class: "devices-list" },
    el("div", { class: "side-label devices-list-label" },
      "Devices",
      el("span", { class: "devices-list-count" },
        `${opts.devices.length} registered · ${onlineCount} online`),
    ),
    el("div", { class: "devices-list-scroll" }, listScroll),
  ));

  // ── right: detail ──
  const detail = el("div", { class: "dev-detail" });
  if (!selected) {
    detail.append(el("div", { class: "card" },
      el("div", { class: "card-body" },
        el("div", { class: "empty-cell", style: "padding:22px 4px;text-align:center" },
          opts.devices.length ? "Select a device to inspect." : "No devices registered yet."),
      ),
    ));
  } else {
    const devicePrompts = opts.prompts.filter((p) => p.deviceId === selected.deviceId);
    const byAction = new Map<string, number>();
    for (const p of devicePrompts) byAction.set(p.action, (byAction.get(p.action) ?? 0) + 1);
    const busy = selected.online && (selected.runningSessions ?? 0) > 0;
    const kv = (label: string, value: Node | string): HTMLElement =>
      el("div", {}, el("dt", {}, label), el("dd", {}, value));

    // Identity card — flat two-column grid, no folding.
    detail.append(el("div", { class: "card" },
      el("div", { class: "card-head" },
        el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("devices")),
        el("div", {},
          el("div", { class: "t" }, selected.name),
          el("div", { class: "d" }, `${selected.platform} · ${selected.version} · ${selected.keyName ?? "—"}`),
        ),
        el("div", { class: "card-actions" },
          // CoCo entry: phones have no sidebar device row, so the workspace is
          // reached from the device's own card (same semantic, same gate).
          opts.onOpenCoco && deviceCocoReady(selected)
            ? el("button", {
                class: "ghost-btn coco-entry-btn",
                type: "button",
                title: "Open CoCo",
                "aria-label": `Open CoCo on ${selected.name}`,
                onclick: () => opts.onOpenCoco?.(selected),
              }, cocoIconMarkup("logo"), el("span", { class: "btn-label" }, "CoCo"))
            : null,
          el("button", { class: selected.blocked ? "ghost-btn action-primary" : "ghost-btn", onclick: () => opts.onBlock(selected, !selected.blocked) },
            selected.blocked ? "Unblock" : "Block"),
          el("button", { class: "ghost-btn danger action-danger", onclick: () => opts.onRemove(selected) }, "Remove"),
        ),
      ),
      el("div", { class: "card-body" },
        el("dl", { class: "kv" },
          kv("Device ID", el("span", { class: "mono" }, selected.deviceId)),
          kv("Status",
            `${selected.online ? "online" : "offline"}${busy ? ` · ${selected.runningSessions} session${selected.runningSessions === 1 ? "" : "s"} running` : ""}${selected.blocked ? " · blocked" : ""}`),
          kv("Key", selected.keyName ?? "—"),
          kv("First seen", new Date(selected.firstSeen).toLocaleString()),
          kv("Last seen", `${new Date(selected.lastSeen).toLocaleString()} · ${relTime(selected.lastSeen)}`),
          kv("IP", el("span", { class: "mono" }, selected.ip ?? "—")),
          kv("User-Agent", el("span", { class: "mono" }, selected.ua ?? "—")),
        ),
      ),
    ));

    if (opts.providerManagementCard) {
      detail.append(opts.providerManagementCard);
    }

    if (opts.mcpManagementCard) {
      detail.append(opts.mcpManagementCard);
    }

    if (opts.skillManagementCard) {
      detail.append(opts.skillManagementCard);
    }

    // Maintenance card (agentd devices) — restart / update / reboot.
    if (opts.maintenance) {
      detail.append(buildMaintenanceCard(selected, opts.maintenance));
    }

    // IP history card.
    const ipHist = selected.ipHistory ?? [];
    const ipScroll = el("div", { class: "card-scroll" });
    if (!ipHist.length) {
      ipScroll.append(el("div", { class: "empty-cell", style: "padding:14px 16px" },
        "No connections recorded yet — the device has not checked in since the relay upgrade."));
    } else {
      for (const h of ipHist) {
        ipScroll.append(el("div", { class: "ip-hist-row" },
          el("span", { class: "ip" }, h.ip),
          el("span", { class: "when" }, new Date(h.ts).toLocaleString()),
        ));
      }
    }
    detail.append(el("div", { class: "card" },
      el("div", { class: "card-head" },
        el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("ip")),
        el("div", {},
          el("div", { class: "t" }, "IP History"),
          el("div", { class: "d" }, `${ipHist.length} connection${ipHist.length === 1 ? "" : "s"} recorded, newest first`),
        ),
      ),
      el("div", { class: "card-body flush" }, ipScroll),
    ));

    // Remote-op stats card — counted from the prompts log window.
    const opsBody = el("div", { class: "card-body" });
    if (!devicePrompts.length) {
      opsBody.append(el("div", { class: "cell-sub" }, "No remote operations recorded for this device."));
    } else {
      const summary = el("div", { class: "ops-summary" },
        el("span", { class: "ops-count" }, `${devicePrompts.length} ops`),
        el("span", { class: "cell-sub" }, ` · `),
        el("span", { class: "cell-sub" },
          [...byAction.entries()].sort((a, b) => b[1] - a[1]).map(([act, n]) => `${act} × ${n}`).join(" · "),
        ),
      );
      opsBody.append(summary);
      for (const p of devicePrompts.slice(0, 5)) {
        opsBody.append(el("div", { class: "ops-line" },
          el("span", { class: "op-main" },
            el("span", { class: "op-act" }, `${p.action} · ${relTime(p.ts)} · `),
            el("span", {}, p.text.length > 120 ? `${p.text.slice(0, 120)}…` : p.text),
          ),
        ));
      }
      if (devicePrompts.length > 5) {
        opsBody.append(el("div", { class: "cell-sub", style: "margin-top:8px" },
          `${devicePrompts.length - 5} older entries are in the Remote Prompts card under Manage.`));
      }
    }
    detail.append(el("div", { class: "card" },
      el("div", { class: "card-head" },
        el("span", { class: "ic card-header-symbol" }, cardHeaderIcon("operations")),
        el("div", {},
          el("div", { class: "t" }, "Remote Operation Stats"),
          el("div", { class: "d" }, `from the latest ${opts.prompts.length} remote prompts`),
        ),
      ),
      opsBody,
    ));
  }
  body.append(detail);
  return body;
}
