import "./styles/tokens.css";
import "./notify-popup.css";
import { Bell, X, createLucideIcon } from "./ui/icons.js";
import { playNotifyChime } from "./ui/attentionSounds.js";
import { bootstrapThemeFromSettings } from "./state/bootstrapTheme.js";


const params = new URLSearchParams(window.location.search);
const entryId = Number(params.get("id") ?? "0");
const title = params.get("title") ?? "Notification";
const body = params.get("body") ?? "";
const lifetimeParam = Number(params.get("ms") ?? "");
const lifetimeMs =
  Number.isFinite(lifetimeParam) && lifetimeParam > 0 ? lifetimeParam : 10_000;

async function main(): Promise<void> {
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
  close.append(createLucideIcon(X, { size: 11 }));

  head.append(bell, titleEl, close);

  const bodyEl = document.createElement("div");
  bodyEl.className = "notify-body";
  bodyEl.textContent = body;

  const progress = document.createElement("div");
  progress.className = "notify-progress";

  card.append(head, bodyEl, progress);
  host.replaceChildren(card);

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
