import "./app-notifications.css";
import { Bell, X, createLucideIcon } from "./icons.js";
import { playNotifyChime } from "./attentionSounds.js";
import { formatRelativeTime } from "../navigation/formatRelativeTime.js";

/**
 * Renderer half of the self-owned notification system
 * (docs/plans/20261008-bone-brand-icon-and-custom-notifications):
 * - in-app toast stack (window top-right, below the title bar) when a
 *   notification arrives with `present: "toast"` (app foreground);
 * - bell inbox popover (unread ledger survives popup/toast timeouts) —
 *   only notifications the hub filed with `inbox: true` appear here;
 *   transient ones toast and are gone;
 * - clicks on any surface mark read and jump to the session.
 *
 * The main process (src/main/appNotify.ts) owns the ledger; this module is
 * a pure mirror driven by `onAppNotify` snapshots.
 */

/** Structural mirror of the bridge payload (env.d.ts keeps the source). */
export interface AppNotifyEntryLocal {
  id: number;
  title: string;
  body: string;
  sessionId?: string;
  createdAt: number;
  read: boolean;
}

export interface AppNotifySnapshotLocal {
  entries: AppNotifyEntryLocal[];
  unreadCount: number;
  latestId?: number;
  /**
   * Full content of the `latestId` entry. Transient notifications (hub
   * `inbox !== true`) are never filed in `entries`, so the toast must read
   * its card from here.
   */
  latest?: AppNotifyEntryLocal;
  present?: "toast" | "popup";
}

export interface NotifyBridgeLike {
  getNotifyLedger: () => Promise<AppNotifySnapshotLocal>;
  markNotifyRead: (req: {
    id?: number;
    all?: boolean;
  }) => Promise<AppNotifySnapshotLocal>;
  clearNotifyLedger: () => Promise<AppNotifySnapshotLocal>;
  onAppNotify: (
    handler: (snapshot: AppNotifySnapshotLocal) => void,
  ) => () => void;
}

const TOAST_MAX = 3;
const TOAST_MS = 10_000;
const PANEL_MAX_ROWS = 30;

export class AppNotificationCenter {
  private readonly toastStack: HTMLElement;
  private readonly panel: HTMLElement;
  private readonly panelList: HTMLElement;
  private readonly emptyState: HTMLElement;
  private readonly markAllButton: HTMLButtonElement;
  private snapshot: AppNotifySnapshotLocal = { entries: [], unreadCount: 0 };
  private bridge: NotifyBridgeLike | undefined;
  private bellButton: HTMLElement | undefined;
  private unsub: (() => void) | undefined;
  private panelOpen = false;

  private readonly onDocClick = (event: MouseEvent): void => {
    if (!this.panelOpen) return;
    const target = event.target;
    if (
      target instanceof Node &&
      this.panel.contains(target)
    ) {
      return;
    }
    if (
      target instanceof Node &&
      this.bellButton?.contains(target)
    ) {
      return; // the bell's own click toggles
    }
    this.togglePanel(false);
  };

  private readonly onDocKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && this.panelOpen) this.togglePanel(false);
  };

  constructor(private readonly opts: {
    onOpenSession: (sessionId: string) => void;
    onUnreadCount?: (count: number) => void;
  }) {
    this.toastStack = document.createElement("div");
    this.toastStack.className = "app-notify-toast-stack";
    document.body.append(this.toastStack);

    this.panel = document.createElement("div");
    this.panel.className = "app-notify-inbox";
    this.panel.setAttribute("role", "dialog");
    this.panel.setAttribute("aria-label", "Notifications");
    this.panel.hidden = true;

    const head = document.createElement("div");
    head.className = "app-notify-inbox-head";
    const title = document.createElement("span");
    title.className = "app-notify-inbox-title";
    title.textContent = "Notifications";
    const markAll = document.createElement("button");
    markAll.type = "button";
    markAll.className = "app-notify-inbox-mark";
    markAll.textContent = "Mark all read";
    markAll.addEventListener("click", () => {
      // Mode follows the live snapshot (synced in renderPanel): unread →
      // mark all read; everything read → clear the ledger.
      if (this.snapshot.unreadCount > 0) {
        void this.bridge?.markNotifyRead({ all: true });
      } else {
        void this.bridge?.clearNotifyLedger();
      }
    });
    head.append(title, markAll);
    this.markAllButton = markAll;

    this.panelList = document.createElement("div");
    this.panelList.className = "app-notify-inbox-list";

    this.emptyState = document.createElement("div");
    this.emptyState.className = "app-notify-inbox-empty";
    this.emptyState.textContent = "No unread notifications";

    this.panel.append(head, this.panelList, this.emptyState);
    document.body.append(this.panel);

    document.addEventListener("click", this.onDocClick, true);
    document.addEventListener("keydown", this.onDocKey);
  }

  destroy(): void {
    document.removeEventListener("click", this.onDocClick, true);
    document.removeEventListener("keydown", this.onDocKey);
    this.unsub?.();
    this.toastStack.remove();
    this.panel.remove();
  }

  /** The bell button toggles the inbox popover. */
  attachBell(button: HTMLElement): void {
    this.bellButton = button;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.togglePanel();
    });
  }

  start(bridge: NotifyBridgeLike): void {
    this.bridge = bridge;
    this.unsub = bridge.onAppNotify((snap) => this.apply(snap));
    // Seed (latestId absent — never toasts); events racing the seed are
    // idempotent snapshots.
    void bridge
      .getNotifyLedger()
      .then((snap) => this.apply(snap))
      .catch(() => {});
  }

  private apply(snap: AppNotifySnapshotLocal): void {
    this.snapshot = snap;
    this.opts.onUnreadCount?.(snap.unreadCount);
    if (this.panelOpen) this.renderPanel();
    if (snap.latestId !== undefined && snap.present === "toast") {
      // `latest` first: transient notifications are not in `entries`.
      const entry =
        snap.latest ?? snap.entries.find((e) => e.id === snap.latestId);
      if (entry) {
        // Foreground arrival: this window owns the ding. The background
        // popup branch plays in its own renderer (notifyPopupMain) — the
        // main window may be gone entirely (Windows tray resident mode).
        playNotifyChime();
        this.showToast(entry);
      }
    }
  }

  /** Live (non-leaving) toast cards — capacity counts only these. */
  private liveToastCards(): HTMLElement[] {
    return [...this.toastStack.children].filter(
      (child): child is HTMLElement =>
        child instanceof HTMLElement && !child.classList.contains("is-leaving"),
    );
  }

  private showToast(entry: AppNotifyEntryLocal): void {
    // Overflow eviction is synchronous — dismissCard removes on animation
    // end, so trimming through it would never shrink children.length and
    // spin forever. Evicted cards' auto-dismiss timers no-op via isConnected.
    // Stack is newest-first (prepend), so the OLDEST live card is last.
    while (this.liveToastCards().length >= TOAST_MAX) {
      this.liveToastCards().at(-1)!.remove();
    }

    const card = document.createElement("div");
    card.className = "app-notify-card is-entering";
    card.dataset.entryId = String(entry.id);

    const head = document.createElement("div");
    head.className = "app-notify-head";
    const bell = createLucideIcon(Bell, { size: 16 });
    bell.classList.add("app-notify-bell");
    head.append(bell);
    const title = document.createElement("span");
    title.className = "app-notify-title";
    title.textContent = entry.title;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "app-notify-close";
    close.setAttribute("aria-label", "Dismiss");
    close.title = "Dismiss";
    // One <svg> with both strokes — see notifyPopupMain.ts (two sibling
    // svgs drew two side-by-side halves instead of a single ✕).
    close.append(createLucideIcon(X, { size: 11 }));
    head.append(title, close);

    const body = document.createElement("div");
    body.className = "app-notify-body";
    body.textContent = entry.body;

    const progress = document.createElement("div");
    progress.className = "app-notify-progress";

    card.append(head, body, progress);
    // Drain bar mirrors the auto-dismiss timer — hand the CSS its duration
    // so the two can never drift apart (they did: 5s bar vs 10s timer).
    card.style.setProperty("--anc-lifetime", `${TOAST_MS}ms`);
    this.toastStack.prepend(card);
    requestAnimationFrame(() => card.classList.remove("is-entering"));

    const timer = window.setTimeout(() => this.dismissCard(card), TOAST_MS);
    card.addEventListener("click", (event) => {
      if (event.target instanceof Node && close.contains(event.target)) {
        window.clearTimeout(timer);
        this.dismissCard(card); // timed-out semantics: stays unread
        return;
      }
      window.clearTimeout(timer);
      this.activate(entry);
      this.dismissCard(card);
    });
  }

  /** Exit animation then removal (reduced-motion: immediate). */
  private dismissCard(card: HTMLElement): void {
    if (!card.isConnected) return;
    card.classList.add("is-leaving");
    const done = (): void => card.remove();
    card.addEventListener("transitionend", done, { once: true });
    window.setTimeout(done, 240);
  }

  private activate(entry: AppNotifyEntryLocal): void {
    if (!entry.read) void this.bridge?.markNotifyRead({ id: entry.id });
    if (entry.sessionId) this.opts.onOpenSession(entry.sessionId);
    this.togglePanel(false);
  }

  togglePanel(open?: boolean): void {
    const next = open ?? !this.panelOpen;
    if (next === this.panelOpen) return;
    this.panelOpen = next;
    if (next) this.positionPanel();
    this.renderPanel();
    this.panel.hidden = false;
    // Hidden locks the fade transition out; toggle after unhide.
    requestAnimationFrame(() => {
      this.panel.classList.toggle("is-open", next);
      if (!next) {
        window.setTimeout(() => {
          if (!this.panelOpen) this.panel.hidden = true;
        }, 160);
      }
    });
  }

  /** Anchor under the bell (fixed, right-aligned to the button). */
  private positionPanel(): void {
    const bell = this.bellButton;
    if (!bell) return;
    const rect = bell.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - rect.right);
    this.panel.style.right = `${Math.round(right)}px`;
    this.panel.style.top = `${Math.round(rect.bottom + 6)}px`;
  }

  private renderPanel(): void {
    const entries = this.snapshot.entries.slice(0, PANEL_MAX_ROWS);
    // Action chip mode: unread → "Mark all read"; everything read →
    // "Clear all"; hidden when the ledger is empty (nothing left to do).
    const hasUnread = this.snapshot.unreadCount > 0;
    this.markAllButton.textContent = hasUnread ? "Mark all read" : "Clear all";
    this.markAllButton.title = hasUnread ? "" : "Clear all notifications";
    this.markAllButton.hidden = !hasUnread && this.snapshot.entries.length === 0;
    this.panelList.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `app-notify-row${entry.read ? " is-read" : ""}`;
      const dot = document.createElement("span");
      dot.className = "app-notify-dot";
      const bodyWrap = document.createElement("span");
      bodyWrap.className = "app-notify-row-body";
      const title = document.createElement("span");
      title.className = "app-notify-row-title";
      title.textContent = entry.title;
      const snippet = document.createElement("span");
      snippet.className = "app-notify-row-snippet";
      snippet.textContent = entry.body;
      bodyWrap.append(title, snippet);
      const time = document.createElement("span");
      time.className = "app-notify-row-time";
      time.textContent = formatRelativeTime(entry.createdAt);
      row.append(dot, bodyWrap, time);
      row.addEventListener("click", () => this.activate(entry));
      this.panelList.append(row);
    }
    const empty = entries.length === 0;
    this.panelList.hidden = empty;
    this.emptyState.hidden = !empty;
  }
}
