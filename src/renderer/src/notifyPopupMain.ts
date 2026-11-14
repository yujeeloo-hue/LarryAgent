import "./styles/tokens.css";
import "./notify-popup.css";
import { Bell, X, createLucideIcon } from "./ui/icons.js";
import { playNotifyChime } from "./ui/attentionSounds.js";
import { bootstrapThemeFromSettings } from "./state/bootstrapTheme.js";

/**
 * Background notification popup — the frameless always-on-top card that
 * appears beside the macOS menu bar / above the Windows taskbar while the
 * app is unfocused (docs/demo/app-notify, signed off). The main process
 * owns the hard close; this page only paints the card, the countdown
 * hint, and routes clicks back via `notifyPopupAction`.
 */

const params = new URLSearchParams(window.location.search);
const entryId = Number(params.get("id") ?? "0");
const title = params.get("title") ?? "Notification";
const body = params.get("body") ?? "";
/** Hard-close lifetime from the main process (ms); drives the drain bar. */
const lifetimeParam = Number(params.get("ms") ?? "");
const lifetimeMs =
  Number.isFinite(lifetimeParam) && lifetimeParam > 0 ? lifetimeParam : 10_000;

async function main(): Promise<void> {
  // Theme parity with the main window (persisted settings, same tokens).
  await bootstrapThemeFromSettings();

  const bridge = window.jellybot;
  const platform = bridge?.platform ?? "darwin";
  document.documentElement.dataset.platform = platform;
  document.documentElement.style.setProperty(
    "--np-lifetime",
    `${lifetimeMs}ms`,
  );

  const host = document.querySelector("#app");
  if (!(host instanceof HTMLElement)) {
    throw new Error("Missing #app mount point");
  }

  const card = document.createElement("div");
  card.className = "notify-card";

  const head = document.createElement("div");
  head.className = "notify-head";

  const bell = createLucideIcon(Bell, { size: 16 });
  bell.classList.add("notify-bell");

  const titleEl = document.createElement("span");
  titleEl.className = "notify-title";
  titleEl.textContent = title;

  const close = document.createElement("button");
  close.type = "button";
  close.className = "notify-close";
  close.setAttribute("aria-label", "Dismiss");
  close.title = "Dismiss";
  // One <svg> with both strokes — two sibling svgs rendered as two
  // side-by-side halves instead of a single ✕ (the signed-off demo's
  // markup was one svg / two <path>s).
  close.append(createLucideIcon(X, { size: 11 }));

  head.append(bell, titleEl, close);

  const bodyEl = document.createElement("div");
  bodyEl.className = "notify-body";
  bodyEl.textContent = body;

  const progress = document.createElement("div");
  progress.className = "notify-progress";

  card.append(head, bodyEl, progress);
  host.replaceChildren(card);

  // Arrival cue: the popup renderer owns the ding in the background case
  // (the main window's toast path never runs here — and in Windows tray
  // resident mode there may be no other renderer alive at all).
  playNotifyChime();

  const act = (action: "activate" | "dismiss"): void => {
    void bridge?.notifyPopupAction?.(entryId, action);
  };
  card.addEventListener("click", (e) => {
    if (e.target instanceof Node && close.contains(e.target)) {
      act("dismiss");
      return;
    }
    act("activate");
  });
}

window.addEventListener("error", (event) => {
  console.error("[notify-popup] uncaught error", event.error ?? event.message);
});

void main();
