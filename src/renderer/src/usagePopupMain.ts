import "./styles/tokens.css";
import "./usage-popup.css";
import {
  createLucideIcon,
  Plus,
  Power,
  RefreshCw,
  Settings,
  X,
} from "./ui/icons.js";
import { createLucideIcon as createOriginalIcon } from "./ui/originalIcons.js";
import { bootstrapThemeFromSettings } from "./state/bootstrapTheme.js";
import { isThemeId } from "./state/theme.js";
import { applyTheme } from "./state/themeManager.js";
import { applyCaptionTimingVars, createCaptionRotator } from "./usageCaption.js";
import type { CaptionRotator } from "./usageCaption.js";


const WINDOWS_VERTICAL_CHROME_PX = 6 + 16;

const SECTION_ORDER: readonly UsageProviderKey[] = [
  "glm-code",
  "kimi-code",
  "kimi",
  "deepseek",
  "openrouter",
  "qwen-code",
];

function sortSections(
  snapshots: ProviderUsageSnapshot[],
  activeKey: UsageProviderKey | null,
): ProviderUsageSnapshot[] {
  return [...snapshots].sort((a, b) => {
    if (a.key === activeKey && b.key !== activeKey) return -1;
    if (b.key === activeKey && a.key !== activeKey) return 1;
    return SECTION_ORDER.indexOf(a.key) - SECTION_ORDER.indexOf(b.key);
  });
}

function formatUpdated(fetchedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000));
  if (seconds < 10) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
}

function el(
  tag: string,
  className: string,
  text?: string,
): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderBar(bar: UsageBar): HTMLElement {
  const row = el("div", "up-bar-row");
  row.append(el("span", "up-bar-label", bar.label));
  const track = el("div", "up-track");
  const fill = el("div", "up-fill");
  const clamped = Math.max(0, Math.min(100, bar.percent));
  fill.style.width = clamped > 0 ? `max(${clamped}%, 3px)` : "0%";
  track.append(fill);
  row.append(track);
  const percent = Number.isInteger(bar.percent)
    ? String(bar.percent)
    : bar.percent.toFixed(1);
  row.append(el("span", "up-pct", `${percent}%`));
  return row;
}

function renderSection(
  snapshot: ProviderUsageSnapshot,
  rotator: CaptionRotator,
): HTMLElement {
  const section = el("section", "up-section");
  const head = el("div", "up-head");
  head.append(el("span", "up-title", snapshot.title));
  if (snapshot.badge) {
    head.append(el("span", "up-badge", snapshot.badge.toUpperCase()));
  }
  section.append(head);
  if (snapshot.error) {
    section.append(el("div", "up-error", snapshot.error));
    return section;
  }
  for (const bar of snapshot.bars) section.append(renderBar(bar));
  rotator.add(section, snapshot.lines);
  return section;
}

function renderSkeleton(container: HTMLElement): void {
  container.replaceChildren(
    ...[0, 1].map(() => {
      const section = el("section", "up-section");
      section.append(
        el("div", "up-skel up-skel-title"),
        el("div", "up-skel up-skel-bar"),
        el("div", "up-skel up-skel-bar"),
        el("div", "up-skel up-skel-line"),
      );
      return section;
    }),
  );
}

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

async function main(): Promise<void> {
  const initialTheme = new URLSearchParams(window.location.search).get("theme");
  if (isThemeId(initialTheme)) applyTheme(initialTheme);
  applyCaptionTimingVars();

  const bridge = window.jellybot;
  document.documentElement.dataset.platform = bridge?.platform ?? "darwin";

  const host = document.querySelector("#app");
  if (!(host instanceof HTMLElement)) {
    throw new Error("Missing #app mount point");
  }

  const card = el("div", "usage-card");
  const sections = el("div", "up-sections");
  const footer = el("div", "up-footer");
  const updated = el("span", "up-updated", "Loading…");

  const refreshBtn = document.createElement("button");
  refreshBtn.type = "button";
  refreshBtn.className = "up-icon-btn";
  refreshBtn.title = "Refresh";
  refreshBtn.setAttribute("aria-label", "Refresh");
  refreshBtn.append(createLucideIcon(RefreshCw, { size: 14 }));

  const newTaskBtn = document.createElement("button");
  newTaskBtn.type = "button";
  newTaskBtn.className = "up-icon-btn";
  newTaskBtn.title = "New Task";
  newTaskBtn.setAttribute("aria-label", "New Task");
  newTaskBtn.append(createOriginalIcon(Plus, { size: 14 }));

  const settingsBtn = document.createElement("button");
  settingsBtn.type = "button";
  settingsBtn.className = "up-icon-btn";
  settingsBtn.title = "Settings";
  settingsBtn.setAttribute("aria-label", "Settings");
  settingsBtn.append(createOriginalIcon(Settings, { size: 14 }));

  const quitBtn = document.createElement("button");
  quitBtn.type = "button";
  quitBtn.className = "up-icon-btn";
  quitBtn.title = "Quit Larry Agent";
  quitBtn.setAttribute("aria-label", "Quit Larry Agent");
  quitBtn.append(createOriginalIcon(Power, { size: 14 }));

  footer.append(refreshBtn, updated, newTaskBtn, settingsBtn, quitBtn);
  card.append(sections, footer);

  const platform = bridge?.platform ?? "darwin";
  if (platform === "win32") {
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "up-close-btn";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.append(createLucideIcon(X, { size: 13 }));
    closeBtn.addEventListener("click", () => {
      bridge?.usagePopupAction?.({ type: "close" });
    });
    card.append(closeBtn);
  }
  host.replaceChildren(card);

  let lastReportedHeight = 0;
  const reportSize = (force = false): void => {
    requestAnimationFrame(() => {
      const chrome =
        document.documentElement.dataset.platform === "win32"
          ? WINDOWS_VERTICAL_CHROME_PX
          : 0;
      const height = Math.ceil(card.getBoundingClientRect().height + chrome);
      if (!force && height === lastReportedHeight) return;
      lastReportedHeight = height;
      bridge?.usagePopupAction?.({ type: "resize", height });
    });
  };

  let rotator = createCaptionRotator({
    prefersReducedMotion: prefersReducedMotion(),
  });

  bridge?.onUsagePopupPresent?.((payload) => {
    if (!payload || typeof payload !== "object") return;
    if (isThemeId(payload.theme)) {
      applyTheme(payload.theme, payload.accentColor);
    }
    if (payload.visible) void load(false);
    else rotator.stop();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") rotator.stop();
  });

  let lastRenderKey: string | null = null;

  const load = async (force: boolean): Promise<void> => {
    refreshBtn.disabled = true;
    refreshBtn.classList.add("is-busy");
    try {
      const result = await bridge?.getProviderUsage?.({ force });
      const snapshots = result?.snapshots ?? [];
      const key = JSON.stringify([result?.activeKey ?? null, snapshots]);
      if (!force && key === lastRenderKey) {
        const latest = snapshots.reduce(
          (max, snap) => Math.max(max, snap.fetchedAt),
          0,
        );
        updated.textContent = latest > 0 ? formatUpdated(latest) : "—";
        return;
      }
      lastRenderKey = key;
      rotator.stop();
      rotator = createCaptionRotator({
        prefersReducedMotion: prefersReducedMotion(),
      });
      if (snapshots.length === 0) {
        const empty = el("div", "up-section");
        empty.append(
          el("div", "up-empty-title", "No supported provider"),
          el(
            "div",
            "up-empty-hint",
            "Kimi Code, GLM Code, Qwen Code, Kimi, DeepSeek, and OpenRouter usage shows up here once a matching provider is configured with an API key.",
          ),
        );
        sections.replaceChildren(empty);
      } else {
        sections.replaceChildren(
          ...sortSections(snapshots, result?.activeKey ?? null).map(
            (snapshot) => renderSection(snapshot, rotator),
          ),
        );
      }
      const latest = snapshots.reduce(
        (max, snap) => Math.max(max, snap.fetchedAt),
        0,
      );
      updated.textContent = latest > 0 ? formatUpdated(latest) : "—";
    } catch {
      lastRenderKey = null;
      sections.replaceChildren(
        el("div", "up-section up-error", "Failed to load usage data"),
      );
      updated.textContent = "—";
    } finally {
      rotator.start();
      refreshBtn.disabled = false;
      refreshBtn.classList.remove("is-busy");
      reportSize();
    }
  };

  renderSkeleton(sections);
  reportSize();
  void bootstrapThemeFromSettings().then(() => reportSize());

  refreshBtn.addEventListener("click", () => void load(true));
  newTaskBtn.addEventListener("click", () =>
    bridge?.usagePopupAction?.({ type: "new-task" }),
  );
  settingsBtn.addEventListener("click", () =>
    bridge?.usagePopupAction?.({ type: "settings" }),
  );
  quitBtn.addEventListener("click", () =>
    bridge?.usagePopupAction?.({ type: "quit" }),
  );
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      bridge?.usagePopupAction?.({ type: "close" });
    }
  });

  await load(false);
}

window.addEventListener("error", (event) => {
  console.error("[usage-popup] uncaught error", event.error ?? event.message);
});

void main();
