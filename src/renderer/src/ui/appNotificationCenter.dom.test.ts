/**
 * App notification center — DOM behaviour (toast stack, bell inbox,
 * read/jump wiring) against a fake bridge.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  requestAnimationFrame: (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  },
});
if (typeof dom.window.setTimeout !== "function") {
  Object.assign(dom.window, {
    setTimeout: (cb: () => void, ms?: number) => setTimeout(cb, ms),
    clearTimeout: (id: NodeJS.Timeout) => clearTimeout(id),
  });
}
if (typeof dom.window.innerWidth !== "number") {
  Object.defineProperty(dom.window, "innerWidth", { value: 1280 });
}

type Snapshot = import("./appNotificationCenter.js")["AppNotifySnapshotLocal"];
type CenterT = typeof import("./appNotificationCenter.js")["AppNotificationCenter"];
let AppNotificationCenter: CenterT;

test.before(async () => {
  ({ AppNotificationCenter } = await import("./appNotificationCenter.js"));
});

function entry(overrides: Partial<Snapshot["entries"][number]> = {}) {
  return {
    id: 1,
    title: "Task finished",
    body: "Refactor pass · 12m",
    sessionId: "session-1",
    createdAt: Date.now(),
    read: false,
    ...overrides,
  };
}

function snap(overrides: Partial<Snapshot> = {}): Snapshot {
  return { entries: [], unreadCount: 0, ...overrides };
}

/** Fake bridge: captures the onAppNotify handler; actions are recorded. */
function makeBridge(seed: Snapshot = snap()) {
  const state: {
    pushed: Array<{ id?: number; all?: boolean }>;
    cleared: number;
  } = { pushed: [], cleared: 0 };
  let handler: ((s: Snapshot) => void) | undefined;
  return {
    state,
    emit: (s: Snapshot) => handler?.(s),
    bridge: {
      getNotifyLedger: async () => seed,
      markNotifyRead: async (req: { id?: number; all?: boolean }) => {
        state.pushed.push(req);
        return snap();
      },
      clearNotifyLedger: async () => {
        state.cleared += 1;
        return snap();
      },
      onAppNotify: (h: (s: Snapshot) => void) => {
        handler = h;
        return () => {
          handler = undefined;
        };
      },
    },
  };
}

function makeCenter() {
  const opened: string[] = [];
  const unread: number[] = [];
  const center = new AppNotificationCenter({
    onOpenSession: (sessionId) => opened.push(sessionId),
    onUnreadCount: (count) => unread.push(count),
  });
  const bell = document.createElement("button");
  center.attachBell(bell);
  return { center, bell, opened, unread };
}

test.afterEach(() => {
  for (const el of document.querySelectorAll(
    ".app-notify-toast-stack, .app-notify-inbox",
  )) {
    el.remove();
  }
});

test("start() seeds the unread badge without toasting", async () => {
  const { center, unread } = makeCenter();
  const { bridge } = makeBridge(
    snap({ entries: [entry()], unreadCount: 1 }),
  );
  center.start(bridge);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(unread, [1]);
  assert.equal(document.querySelectorAll(".app-notify-card").length, 0);
  center.destroy();
});

test("toast present renders one card with entry content", async () => {
  const { center } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  fake.emit(
    snap({
      entries: [entry({ id: 7, title: "Deploy done", body: "Relay · 3m" })],
      unreadCount: 1,
      latestId: 7,
      present: "toast",
    }),
  );
  const cards = document.querySelectorAll<HTMLElement>(".app-notify-card");
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.dataset.entryId, "7");
  assert.match(
    cards[0]!.querySelector(".app-notify-title")!.textContent ?? "",
    /Deploy done/,
  );
  assert.match(
    cards[0]!.querySelector(".app-notify-body")!.textContent ?? "",
    /Relay · 3m/,
  );
  center.destroy();
});

test("popup-present and seed snapshots never toast", async () => {
  const { center } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  fake.emit(
    snap({ entries: [entry({ id: 2 })], unreadCount: 1, latestId: 2, present: "popup" }),
  );
  fake.emit(snap({ entries: [entry({ id: 3 })], unreadCount: 1 }));
  assert.equal(document.querySelectorAll(".app-notify-card").length, 0);
  center.destroy();
});

test("toast stack caps at three (oldest drops)", () => {
  const { center } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  for (let id = 1; id <= 4; id++) {
    fake.emit(
      snap({ entries: [entry({ id })], unreadCount: 1, latestId: id, present: "toast" }),
    );
  }
  const ids = [...document.querySelectorAll<HTMLElement>(".app-notify-card")]
    .filter((c) => !c.classList.contains("is-leaving"))
    .map((c) => c.dataset.entryId);
  assert.equal(ids.length, 3);
  assert.equal(ids[0], "4"); // newest first
  assert.ok(!ids.includes("1"));
  center.destroy();
});

// Transient notifications (hub `inbox !== true`) never enter the ledger, so
// the toast must read its card off `snapshot.latest` — `entries` is empty.
test("latest-only snapshot toasts a transient notification", () => {
  const { center } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  fake.emit(
    snap({
      entries: [],
      unreadCount: 0,
      latestId: 11,
      latest: entry({ id: 11, title: "Deploy started", body: "rsync · 4s", read: true }),
      present: "toast",
    }),
  );
  const cards = document.querySelectorAll<HTMLElement>(".app-notify-card");
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.dataset.entryId, "11");
  assert.match(
    cards[0]!.querySelector(".app-notify-title")!.textContent ?? "",
    /Deploy started/,
  );
  center.destroy();
});

// A transient card carries read:true from the hub, so the click path skips
// the markRead round-trip (the ledger has never seen that id) and still
// jumps to the session.
test("transient toast click opens the session without marking read", () => {
  const { center, opened } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  fake.emit(
    snap({
      entries: [],
      unreadCount: 0,
      latestId: 12,
      latest: entry({ id: 12, sessionId: "s-transient", read: true }),
      present: "toast",
    }),
  );
  (document.querySelector(".app-notify-card") as HTMLElement).click();
  assert.deepEqual(fake.state.pushed, []);
  assert.deepEqual(opened, ["s-transient"]);
  center.destroy();
});

test("card click marks read and opens the session", () => {
  const { center, opened } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  fake.emit(
    snap({ entries: [entry({ id: 9, sessionId: "s-nine" })], unreadCount: 1, latestId: 9, present: "toast" }),
  );
  (document.querySelector(".app-notify-card") as HTMLElement).click();
  assert.deepEqual(fake.state.pushed, [{ id: 9 }]);
  assert.deepEqual(opened, ["s-nine"]);
  center.destroy();
});

test("close (X) dismisses without read or navigation", () => {
  const { center, opened } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  fake.emit(
    snap({ entries: [entry({ id: 5 })], unreadCount: 1, latestId: 5, present: "toast" }),
  );
  const card = document.querySelector(".app-notify-card") as HTMLElement;
  (card.querySelector(".app-notify-close") as HTMLElement).click();
  assert.deepEqual(fake.state.pushed, []);
  assert.deepEqual(opened, []);
  assert.ok(card.classList.contains("is-leaving"));
  center.destroy();
});

test("bell toggles the inbox; rows show content and relative time", () => {
  const { center, bell } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  fake.emit(
    snap({
      entries: [
        entry({ id: 1, title: "Task finished", body: "Refactor pass · 12m" }),
        entry({ id: 2, title: "Loop ran", body: "Daily digest", read: true }),
      ],
      unreadCount: 1,
    }),
  );
  bell.click();
  const panel = document.querySelector(".app-notify-inbox") as HTMLElement;
  assert.equal(panel.hidden, false);
  assert.ok(panel.classList.contains("is-open"));
  const rows = panel.querySelectorAll(".app-notify-row");
  assert.equal(rows.length, 2);
  assert.match(
    rows[0]!.querySelector(".app-notify-row-title")!.textContent ?? "",
    /Task finished/,
  );
  assert.ok(rows[0]!.classList.contains("is-read") === false);
  assert.ok(rows[1]!.classList.contains("is-read"));
  assert.match(
    rows[0]!.querySelector(".app-notify-row-time")!.textContent ?? "",
    /just now|ago/,
  );
  center.destroy();
});

test("Escape closes the inbox", () => {
  const { center, bell } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  bell.click();
  const panel = document.querySelector(".app-notify-inbox") as HTMLElement;
  assert.ok(panel.classList.contains("is-open"));
  const keydown = new dom.window.Event("keydown", { bubbles: true });
  Object.defineProperty(keydown, "key", { value: "Escape" });
  document.dispatchEvent(keydown);
  assert.ok(!panel.classList.contains("is-open"));
  center.destroy();
});

test("row click marks read and opens its session", () => {
  const { center, bell, opened } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  fake.emit(
    snap({ entries: [entry({ id: 3, sessionId: "s-three" })], unreadCount: 1 }),
  );
  bell.click();
  (
    document.querySelector(".app-notify-row") as HTMLElement
  ).click();
  assert.deepEqual(fake.state.pushed, [{ id: 3 }]);
  assert.deepEqual(opened, ["s-three"]);
  center.destroy();
});

test("Mark all read forwards {all:true}", async () => {
  const { center, bell } = makeCenter();
  const fake = makeBridge(snap({ entries: [entry()], unreadCount: 1 }));
  center.start(fake.bridge);
  await new Promise((r) => setTimeout(r, 0)); // seed lands first
  bell.click();
  const mark = document.querySelector(".app-notify-inbox-mark") as HTMLElement;
  assert.match(mark.textContent ?? "", /Mark all read/);
  mark.click();
  assert.deepEqual(fake.state.pushed, [{ all: true }]);
  assert.equal(fake.state.cleared, 0);
  center.destroy();
});

test("all-read ledger flips the chip to Clear all and clears it", () => {
  const { center, bell } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  fake.emit(
    snap({ entries: [entry({ id: 4, read: true })], unreadCount: 0 }),
  );
  bell.click();
  const mark = document.querySelector(".app-notify-inbox-mark") as HTMLElement;
  assert.equal(mark.hidden, false);
  assert.match(mark.textContent ?? "", /Clear all/);
  mark.click();
  assert.deepEqual(fake.state.pushed, []);
  assert.equal(fake.state.cleared, 1);
  center.destroy();
});

test("chip reverts to Mark all read when a new unread arrives", () => {
  const { center, bell } = makeCenter();
  const fake = makeBridge();
  center.start(fake.bridge);
  fake.emit(snap({ entries: [entry({ read: true })], unreadCount: 0 }));
  bell.click();
  fake.emit(snap({ entries: [entry({ id: 2 })], unreadCount: 1 }));
  const mark = document.querySelector(".app-notify-inbox-mark") as HTMLElement;
  assert.match(mark.textContent ?? "", /Mark all read/);
  center.destroy();
});

test("empty ledger hides the action chip entirely", () => {
  const { center, bell } = makeCenter();
  center.start(makeBridge().bridge);
  bell.click();
  const mark = document.querySelector(".app-notify-inbox-mark") as HTMLElement;
  assert.equal(mark.hidden, true);
  center.destroy();
});

test("empty ledger renders the empty state", () => {
  const { center, bell } = makeCenter();
  center.start(makeBridge().bridge);
  bell.click();
  const empty = document.querySelector(".app-notify-inbox-empty") as HTMLElement;
  assert.equal(empty.hidden, false);
  assert.match(empty.textContent ?? "", /No unread notifications/);
  center.destroy();
});

// The list's author `display: grid` outranks the UA [hidden] rule — without
// the explicit guard the "hidden" empty list still paints its 5px bottom
// padding and pushes the empty state text below the optical center.
test("CSS keeps [hidden] authoritative over the grid list", async () => {
  const css = await readFile(
    new URL("./app-notifications.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.app-notify-inbox-list\[hidden\]\s*\{\s*display:\s*none/);
});

// One-message height parity: the popover must render at the same height with
// zero notifications as with one message. Rows and the empty state size
// against the same --anc-row-h token (row + the list's 5px bottom padding),
// so neither state can drift independently.
test("CSS pins the empty state to the one-message row height", async () => {
  const css = await readFile(
    new URL("./app-notifications.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /--anc-row-h:\s*45px/);
  assert.match(css, /\.app-notify-row\s*\{[^}]*min-height:\s*var\(--anc-row-h\)/s);
  assert.match(
    css,
    /\.app-notify-inbox-empty\s*\{[^}]*min-height:\s*calc\(var\(--anc-row-h\)\s*\+\s*5px\)/s,
  );
});

// Clear-all stability: emptying the ledger hides the action chip — the
// head's tallest child — so the head must pin to a height floor or the
// title slides up and the popover retracts (visible jump on Clear all).
// Same floor token pattern as the row-height parity above.
test("CSS pins the inbox head height across chip visibility", async () => {
  const css = await readFile(
    new URL("./app-notifications.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /--anc-head-h:\s*37px/);
  assert.match(
    css,
    /\.app-notify-inbox-head\s*\{[^}]*min-height:\s*var\(--anc-head-h\)/s,
  );
});
