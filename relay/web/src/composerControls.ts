/**
 * Composer controls shared by the New Task panel and the conversation view.
 * Mirrors the Mac TaskComposer layout 1:1 (src/renderer/src/ui/taskComposer):
 * a single [+] round button opens the plus menu (image / attachments /
 * permissions radio), the provider pill opens a menu topped by the Reasoning
 * Effort segmented dial + Infinite switch row, and sending happens through
 * the 28px glass round button at the toolbar's right end. Legacy device
 * builds (no listComposerOptions) never mount this module — callers fall
 * back to the plain textarea composer.
 */
import { icon } from "./icons.js";
import { el } from "./render.js";
import { syncMenuScrim, mountPopoverMenu } from "./mobileNav.js";
import {
  COMPOSER_EFFORT_LEVELS,
  isComposerReasoningEffort,
  type ComposerReasoningEffort,
} from "./types.js";

export interface ComposerProviderOption {
  id: string;
  name: string;
  modelId: string;
}

export interface ComposerControlsState {
  providerId: string | null;
  reasoningEffort: ComposerReasoningEffort;
  infinite: boolean;
  bypass: boolean;
}

/** One attachment chip (uploading or staged for the next turn). */
export interface ComposerAttachmentItem {
  id: string;
  name: string;
  kind: string;
  uploading?: boolean;
  error?: string;
}

export interface ComposerToolbarHandlers {
  onPickFiles?: (files: File[], mode: "images" | "files") => void;
  onRemoveAttachment?: (id: string) => void;
  onPickProvider?: (providerId: string) => void;
  /**
   * The provider menu just opened — a chance to silently re-probe the
   * device's provider list (setProviders repaints the open menu in place
   * when the fresh answer differs from the cached one).
   */
  onProviderMenuOpen?: () => void;
  onReasoningEffortSelect?: (level: ComposerReasoningEffort) => void;
  onToggleInfinite?: (next: boolean) => void;
  /** Permissions radio — `true` selects "Bypass permissions", `false` "Safe mode". */
  onToggleBypass?: (next: boolean) => void;
  /** Round send button (idle state). */
  onSend?: () => void;
  /** Round send button while a turn is running (stop glyph). */
  onStop?: () => void;
}

export interface ComposerToolbarConfig {
  providers: readonly ComposerProviderOption[];
  state: ComposerControlsState;
  /** Device Remote mode "full" — otherwise the Permissions group is hidden. */
  bypassAvailable: boolean;
  /**
   * Label when state.providerId is absent from `providers` (e.g. a session
   * bound to a deleted profile). Shown as a static pill.
   */
  providerFallbackLabel?: string | null;
  /** false → provider pill renders as plain text (no menu). */
  providerSelectable?: boolean;
}

export interface ComposerToolbar {
  /** Toolbar row — mounts below the textarea inside the composer card. */
  root: HTMLElement;
  /** Chips strip — the caller mounts it above the textarea. */
  attachments: HTMLElement;
  /** Round-button wrap — host for the context-usage ring + hover tooltip. */
  sendWrap: HTMLElement;
  setState(patch: Partial<ComposerControlsState>): void;
  setItems(items: readonly ComposerAttachmentItem[]): void;
  /**
   * Swap the provider list live (providers_changed push / menu-open
   * re-probe). Repaints the open menu list + pill in place — no rebuild, so
   * drafts and the open popover survive.
   */
  setProviders(next: readonly ComposerProviderOption[]): void;
  setDisabled(disabled: boolean): void;
  /** Lock session-pinned controls (LLM / effort dial / Infinite) while a turn runs. */
  setLocked(locked: boolean): void;
  /** Swap the send glyph for the stop square (turn running). */
  setRunning(running: boolean): void;
  /**
   * Mac setStopMode parity: `stop` shows the stop square; `steer` keeps the
   * send glyph but relabels it "Queue for after this turn" (submitting while
   * a turn runs enqueues instead of stopping — always clickable).
   */
  setStopMode(stop: boolean, opts?: { steer?: boolean }): void;
  /** Disable/enable only the send round button (empty textarea, offline…). */
  setSendDisabled(disabled: boolean): void;
}

function attachmentIcon(kind: string): string {
  return kind === "image" ? "image" : "file";
}

/** Menu chrome shared by the plus and provider popups. */
function menuChrome(extraClass: string): HTMLElement {
  return el("div", { class: `composer-menu ${extraClass}`, hidden: true });
}

export function buildComposerToolbar(
  config: ComposerToolbarConfig,
  handlers: ComposerToolbarHandlers,
): ComposerToolbar {
  const state: ComposerControlsState = { ...config.state };
  // Guard against stale callers still passing the legacy Max boolean.
  if (!isComposerReasoningEffort(state.reasoningEffort)) {
    (state as { reasoningEffort?: unknown }).reasoningEffort = "low";
  }
  let providers = [...config.providers];
  let disabled = false;
  let locked = false;
  let running = false;
  /** Submit gesture while running: button keeps the send glyph but queues
   * ("Queue for after this turn") instead of stopping — Mac setStopMode
   * steer-label parity. */
  let queueSubmit = false;
  let sendDisabled = false;
  let menuCloseTimers: number[] = [];
  const selectable = config.providerSelectable !== false;

  const later = (fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      menuCloseTimers = menuCloseTimers.filter((x) => x !== t);
      fn();
    }, ms);
    menuCloseTimers.push(t);
  };
  const cancelCloseTimers = () => {
    for (const t of menuCloseTimers) window.clearTimeout(t);
    menuCloseTimers = [];
  };

  // ── attachments strip ────────────────────────────────────────
  const attachments = el("div", { class: "composer-attachments", "aria-label": "Attachments", hidden: true });

  // ── hidden file inputs ───────────────────────────────────────
  const imageInput = el("input", { type: "file", multiple: "", accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml", hidden: true }) as HTMLInputElement;
  const fileInput = el("input", { type: "file", multiple: "", hidden: true }) as HTMLInputElement;
  imageInput.addEventListener("change", () => {
    if (imageInput.files?.length) handlers.onPickFiles?.([...imageInput.files], "images");
    imageInput.value = "";
  });
  fileInput.addEventListener("change", () => {
    if (fileInput.files?.length) handlers.onPickFiles?.([...fileInput.files], "files");
    fileInput.value = "";
  });

  // ── [+] button + plus menu ───────────────────────────────────
  const plusMenu = menuChrome("composer-plus-menu");
  plusMenu.setAttribute("role", "menu");

  const menuItem = (label: string, leadingIcon: string, extraCls = "") => {
    return el("button", {
      class: `composer-menu-item ${extraCls}`,
      type: "button",
      role: "menuitem",
    },
      el("span", { class: "composer-menu-item-leading", "aria-hidden": "true" }, icon(leadingIcon, 16)),
      el("span", { class: "composer-menu-item-label" }, label),
      el("span", { class: "composer-menu-item-check", "aria-hidden": "true" }, icon("check", 14)),
    ) as HTMLButtonElement;
  };

  const imageItem = menuItem("Image…", "image");
  imageItem.addEventListener("click", () => { setPlusOpen(false); imageInput.click(); });
  const attachItem = menuItem("Attachments…", "paperclip");
  attachItem.addEventListener("click", () => { setPlusOpen(false); fileInput.click(); });

  const safeItem = menuItem("Safe mode", "shield", "is-safe-option");
  safeItem.setAttribute("role", "menuitemradio");
  safeItem.addEventListener("click", () => {
    if (safeItem.disabled) return;
    state.bypass = false;
    handlers.onToggleBypass?.(false);
    applyState();
  });
  const fullItem = menuItem("Bypass permissions", "shieldOff", "is-full-option");
  fullItem.setAttribute("role", "menuitemradio");
  fullItem.addEventListener("click", () => {
    if (fullItem.disabled) return;
    state.bypass = true;
    handlers.onToggleBypass?.(true);
    applyState();
  });

  const permGroup = el("div", { class: "composer-plus-menu-group", role: "group", "aria-label": "Permissions" },
    el("div", { class: "composer-plus-menu-label" }, "Permissions"),
    safeItem,
    fullItem,
  );
  permGroup.hidden = !config.bypassAvailable;

  plusMenu.append(imageItem, attachItem, el("div", { class: "composer-menu-separator" }), permGroup);

  const plusBtn = el("button", {
    class: "composer-round-btn composer-plus-btn",
    type: "button",
    "aria-label": "More options",
    "aria-haspopup": "menu",
    "aria-expanded": "false",
    title: "Attachments & permissions",
  }, icon("plus", 16)) as HTMLButtonElement;
  const plusWrap = el("div", { class: "composer-plus-wrap" }, plusBtn, plusMenu);

  // ── provider pill + menu (effort dial + switch row + list) ───
  const providerLabel = el("span", { class: "composer-provider-label" }, "Default");
  const effortChip = el("span", { class: "composer-provider-effort-chip", hidden: true, "aria-hidden": "true" }, "Max");
  const providerBtn = el("button", {
    class: "composer-provider-btn",
    type: "button",
    "aria-haspopup": "listbox",
    "aria-expanded": "false",
    title: "Chat LLM for this task",
  },
    providerLabel,
    effortChip,
    el("span", { class: "composer-provider-chevron", "aria-hidden": "true" }, icon("chevronDown", 14)),
  ) as HTMLButtonElement;

  const makeSwitch = (cls: string, label: string, iconId: "zap" | "infinity", onToggle: (next: boolean) => void) => {
    const sw = el("button", { class: "composer-switch", type: "button", role: "switch", "aria-checked": "false" },
      el("span", { class: "composer-switch-thumb" }),
    ) as HTMLButtonElement;
    sw.addEventListener("click", () => {
      if (sw.disabled) return;
      onToggle(sw.getAttribute("aria-checked") !== "true");
    });
    const row = el("div", { class: `composer-switch-row ${cls}` },
      el("span", { class: "composer-row-head" },
        el("span", { class: "composer-row-icon", "aria-hidden": "true" }, icon(iconId, 14)),
        el("span", {}, label),
      ),
      sw,
    );
    return { sw, row };
  };

  // Reasoning-effort segmented dial (OFF/LOW/MED/HIGH/MAX, Mac parity).
  const effortThumb = el("span", { class: "effort-seg-thumb", "aria-hidden": "true" });
  const effortSeg = el("div", { class: "effort-seg", role: "radiogroup", "aria-label": "Effort" }, effortThumb);
  const effortButtons: HTMLButtonElement[] = [];
  for (const level of COMPOSER_EFFORT_LEVELS) {
    const btn = el("button", {
      class: `effort-seg-item${level.id === "max" ? " is-max" : ""}`,
      type: "button",
      role: "radio",
      "aria-checked": "false",
      title: level.name,
    }, level.short) as HTMLButtonElement;
    btn.addEventListener("click", (e: Event) => {
      e.stopPropagation();
      if (btn.disabled) return;
      state.reasoningEffort = level.id;
      handlers.onReasoningEffortSelect?.(level.id);
      applyState();
    });
    effortButtons.push(btn);
    effortSeg.append(btn);
  }
  const setSegLevel = (level: ComposerReasoningEffort) => {
    const index = COMPOSER_EFFORT_LEVELS.findIndex((l) => l.id === level);
    const safe = index < 0 ? 1 : index;
    effortThumb.style.setProperty("--i", String(safe));
    effortSeg.classList.toggle("is-gold", level === "max");
    // data-level keys the per-level solid thumb/label palette (is-gold owns MAX).
    effortSeg.dataset.level = level;
    effortButtons.forEach((b, i) => b.setAttribute("aria-checked", i === safe ? "true" : "false"));
    paintStepper(safe);
  };

  // ── Mobile form of the effort dial: − value + stepper (≤768px) ──
  // Desktop keeps the segmented dial; CSS swaps the two per breakpoint, so
  // both stay mounted and this painter keeps them in lockstep.
  const stepValue = el("span", { class: "effort-step-value" }, "LOW");
  const stepMinus = el("button", {
    class: "effort-step-btn effort-step-minus",
    type: "button",
    "aria-label": "Lower effort level",
  }, "−") as HTMLButtonElement;
  const stepPlus = el("button", {
    class: "effort-step-btn effort-step-plus",
    type: "button",
    "aria-label": "Raise effort level",
  }, "+") as HTMLButtonElement;
  const effortStepper = el("div", { class: "effort-stepper" }, stepMinus, stepValue, stepPlus);
  let paintedLevel: ComposerReasoningEffort | null = null;
  /** Sync the stepper value/clamps with the dial (bumps only on change). */
  const paintStepper = (safe: number) => {
    const level = COMPOSER_EFFORT_LEVELS[safe]!.id;
    const lockedOut = disabled || locked;
    stepValue.textContent = COMPOSER_EFFORT_LEVELS[safe]!.short;
    stepValue.classList.toggle("is-gold", level === "max");
    stepValue.classList.toggle("is-off", level === "off");
    stepValue.dataset.level = level;
    stepMinus.disabled = lockedOut || safe === 0;
    stepPlus.disabled = lockedOut || safe === COMPOSER_EFFORT_LEVELS.length - 1;
    if (paintedLevel !== level) {
      paintedLevel = level;
      stepValue.classList.remove("is-bump");
      void stepValue.offsetWidth; // restart the CSS animation
      stepValue.classList.add("is-bump");
    }
  };
  const stepBy = (delta: -1 | 1) => {
    const index = COMPOSER_EFFORT_LEVELS.findIndex((l) => l.id === state.reasoningEffort);
    const safe = index < 0 ? 1 : index;
    const next = COMPOSER_EFFORT_LEVELS[Math.max(0, Math.min(COMPOSER_EFFORT_LEVELS.length - 1, safe + delta))];
    if (!next || next.id === state.reasoningEffort) return;
    state.reasoningEffort = next.id;
    handlers.onReasoningEffortSelect?.(next.id);
    applyState();
  };
  stepMinus.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    if (!stepMinus.disabled) stepBy(-1);
  });
  stepPlus.addEventListener("click", (e: Event) => {
    e.stopPropagation();
    if (!stepPlus.disabled) stepBy(1);
  });

  const reasoningRow = el("div", { class: "composer-switch-row composer-reasoning-effort-row" },
    el("span", { class: "composer-row-head" },
      el("span", { class: "composer-row-icon", "aria-hidden": "true" }, icon("zap", 14)),
      el("span", {}, "Effort"),
    ),
    effortSeg,
    effortStepper,
  );

  const infSwitch = makeSwitch("composer-infinite-row", "Infinite", "infinity", (next) => { state.infinite = next; handlers.onToggleInfinite?.(next); applyState(); });

  const providerList = el("div", { class: "composer-provider-menu-list", role: "listbox", "aria-label": "LLM providers" });
  // Read-only notice — the menu stays inspectable while a turn runs
  // (setLocked), provider / effort / Infinite edits stay blocked.
  const lockedHint = el("div", { class: "composer-provider-locked-hint", hidden: true, role: "status" },
    el("span", { class: "composer-row-icon", "aria-hidden": "true" }, icon("lock", 12)),
    el("span", {}, "Read-only while running"),
  );
  const providerMenu = menuChrome("composer-provider-menu");
  providerMenu.append(lockedHint, reasoningRow, infSwitch.row, providerList);
  const providerWrap = el("div", { class: "composer-provider-wrap" }, providerBtn, providerMenu);

  const renderMenuList = () => {
    providerList.replaceChildren();
    if (providers.length === 0) {
      providerList.append(el("p", { class: "composer-provider-menu-empty" }, "No providers configured."));
      return;
    }
    for (const provider of providers) {
      const active = provider.id === state.providerId;
      providerList.append(el("button", {
        class: `composer-provider-item${active ? " is-active" : ""}`,
        type: "button",
        role: "option",
        "aria-selected": active ? "true" : "false",
        ...((disabled || locked) ? { disabled: "" } : {}),
        onclick: (e: Event) => {
          e.stopPropagation();
          setProviderOpen(false);
          if (provider.id !== state.providerId) handlers.onPickProvider?.(provider.id);
        },
      },
        el("span", { class: "composer-provider-item-head" },
          el("span", { class: "composer-provider-item-name" }, provider.name),
        ),
        el("span", { class: "composer-provider-item-model" }, provider.modelId),
      ));
    }
  };

  // ── send round button ────────────────────────────────────────
  const sendBtn = el("button", {
    class: "composer-send-btn",
    type: "button",
    "aria-label": "Send",
    title: "Send",
  }, icon("arrowUp", 16)) as HTMLButtonElement;
  sendBtn.addEventListener("click", () => {
    if (sendBtn.disabled) return;
    if (running) handlers.onStop?.();
    else handlers.onSend?.();
  });
  const sendWrap = el("div", { class: "composer-send-wrap" }, sendBtn);

  // ── menu open/close plumbing ─────────────────────────────────
  // Mobile: both menus restyle into bottom sheets (style.css media query)
  // and share the global scrim — desktop popovers ignore the scrim (hidden).
  const setPlusOpen = (open: boolean) => {
    plusBtn.setAttribute("aria-expanded", open ? "true" : "false");
    plusBtn.classList.toggle("is-open", open);
    if (open) {
      cancelCloseTimers();
      mountPopoverMenu(plusMenu, plusWrap);
      plusMenu.hidden = false;
      void plusMenu.offsetWidth;
      plusMenu.classList.add("is-open");
      syncMenuScrim(true, () => setPlusOpen(false), plusMenu);
    } else {
      plusMenu.classList.remove("is-open");
      syncMenuScrim(false, undefined, plusMenu);
      later(() => { plusMenu.hidden = true; }, 180);
    }
  };
  const setProviderOpen = (open: boolean) => {
    if (!selectable) return;
    providerBtn.setAttribute("aria-expanded", open ? "true" : "false");
    providerBtn.classList.toggle("is-open", open);
    if (open) {
      cancelCloseTimers();
      mountPopoverMenu(providerMenu, providerWrap);
      providerMenu.hidden = false;
      void providerMenu.offsetWidth;
      providerMenu.classList.add("is-open");
      syncMenuScrim(true, () => setProviderOpen(false), providerMenu);
      // Fresh provider data heals stale caches here — the silent re-probe
      // answers through setProviders and repaints this open menu in place.
      handlers.onProviderMenuOpen?.();
    } else {
      providerMenu.classList.remove("is-open");
      syncMenuScrim(false, undefined, providerMenu);
      later(() => { providerMenu.hidden = true; }, 180);
    }
  };

  plusBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (plusBtn.disabled) return;
    const open = !plusBtn.classList.contains("is-open");
    setProviderOpen(false);
    setPlusOpen(open);
  });
  providerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (providerBtn.classList.contains("is-static") || providerBtn.disabled) return;
    const open = !providerBtn.classList.contains("is-open");
    setPlusOpen(false);
    setProviderOpen(open);
  });
  const onDocClick = () => {
    if (!plusWrap.isConnected && !providerWrap.isConnected) {
      document.removeEventListener("click", onDocClick);
      return;
    }
    setPlusOpen(false);
    setProviderOpen(false);
  };
  document.addEventListener("click", onDocClick);
  plusMenu.addEventListener("click", (e) => e.stopPropagation());
  providerMenu.addEventListener("click", (e) => e.stopPropagation());

  // ── root assembly ────────────────────────────────────────────
  const root = el("div", { class: "composer-controls" },
    imageInput,
    fileInput,
    el("div", { class: "composer-controls-left" }, plusWrap),
    el("div", { class: "composer-controls-right" }, providerWrap, sendWrap),
  );

  const syncProviderPill = () => {
    const provider = providers.find((p) => p.id === state.providerId) ?? null;
    if (provider) {
      providerLabel.textContent = provider.name;
      providerBtn.title = `${provider.name} · ${provider.modelId}`;
    } else {
      providerLabel.textContent = config.providerFallbackLabel ?? "Default";
      providerBtn.title = "Chat LLM for this task";
    }
    const level = state.reasoningEffort;
    effortChip.hidden = level === "low" || !provider;
    effortChip.textContent = level.toUpperCase();
    effortChip.classList.toggle("is-max", level === "max");
    effortChip.classList.toggle("is-off", level === "off");
    effortChip.dataset.level = level;
    // Chip visible (MED/HIGH/OFF/MAX) → pill grows, name never ellipsizes.
    providerBtn.classList.toggle("has-effort", level !== "low");
    providerBtn.classList.toggle("is-static", !selectable || providers.length === 0);
    renderMenuList();
  };

  const applyState = () => {
    setSegLevel(state.reasoningEffort);
    sendWrap.classList.toggle("is-infinite", state.infinite);
    infSwitch.sw.classList.toggle("is-on", state.infinite);
    infSwitch.sw.setAttribute("aria-checked", state.infinite ? "true" : "false");
    safeItem.classList.toggle("is-selected", !state.bypass);
    safeItem.setAttribute("aria-checked", state.bypass ? "false" : "true");
    fullItem.classList.toggle("is-selected", state.bypass);
    fullItem.setAttribute("aria-checked", state.bypass ? "true" : "false");
    syncProviderPill();
  };
  applyState();

  const sessionControls = (): HTMLButtonElement[] => [...effortButtons, stepMinus, stepPlus, infSwitch.sw];

  const applyDisabled = () => {
    for (const btn of [plusBtn, imageItem, attachItem, safeItem, fullItem]) btn.disabled = disabled;
    // Locked (turn running) keeps the pill clickable — the menu opens
    // read-only so the bound LLM stays inspectable, just not editable.
    providerBtn.disabled = disabled;
    for (const btn of sessionControls()) btn.disabled = disabled || locked;
    // Stepper buttons re-clamp at the range ends on top of the shared state.
    const index = COMPOSER_EFFORT_LEVELS.findIndex((l) => l.id === state.reasoningEffort);
    const safe = index < 0 ? 1 : index;
    stepMinus.disabled = disabled || locked || safe === 0;
    stepPlus.disabled = disabled || locked || safe === COMPOSER_EFFORT_LEVELS.length - 1;
    for (const btn of providerList.querySelectorAll("button")) btn.disabled = disabled || locked;
    // While a turn runs the button is stop-or-queue — always clickable either
    // way (an empty composer can still promote the queue head).
    sendBtn.disabled = disabled || (running || queueSubmit ? false : sendDisabled);
    root.classList.toggle("is-disabled", disabled);
  };

  /** Mac TaskComposerView.setStopMode parity (see the public alias below). */
  const setStopModeFn = (stop: boolean, opts?: { steer?: boolean }) => {
    running = stop;
    queueSubmit = !stop && opts?.steer === true;
    // The wrap carries the running class — the context-usage ring keyed to
    // it (`.composer-send-wrap.is-running`) recolors with the stop face.
    sendWrap.classList.toggle("is-running", stop);
    sendBtn.classList.toggle("is-stop", stop);
    sendBtn.classList.toggle("is-queue", queueSubmit);
    const label = stop ? "Stop" : queueSubmit ? "Queue for after this turn" : "Send";
    sendBtn.setAttribute("aria-label", label);
    sendBtn.title = label;
    // icon() returns trusted SVG markup — innerHTML, or it renders as text.
    sendBtn.innerHTML = icon(stop ? "stop" : "arrowUp", stop ? 12 : 16);
    applyDisabled();
  };

  return {
    root,
    attachments,
    sendWrap,
    setState(patch: Partial<ComposerControlsState>) {
      Object.assign(state, patch);
      applyState();
    },
    setProviders(next: readonly ComposerProviderOption[]) {
      providers = [...next];
      renderMenuList();
      syncProviderPill();
      applyDisabled();
    },
    setItems(items: readonly ComposerAttachmentItem[]) {
      attachments.replaceChildren();
      attachments.hidden = items.length === 0;
      for (const item of items) {
        const chip = el("div", {
          class: `composer-attachment-chip${item.uploading ? " is-uploading" : ""}${item.error ? " is-error" : ""}`,
          title: item.error ?? item.name,
        },
          el("span", { class: "composer-attachment-chip-icon", "aria-hidden": "true" }, icon(attachmentIcon(item.kind), 12)),
          el("span", { class: "composer-attachment-chip-name" }, item.name),
          item.uploading
            ? el("span", { class: "composer-attachment-chip-spinner", "aria-hidden": "true" })
            : null,
          el("button", {
            class: "composer-attachment-chip-remove",
            type: "button",
            title: item.error ? "Dismiss" : `Remove ${item.name}`,
            "aria-label": item.error ? "Dismiss" : `Remove ${item.name}`,
            onclick: () => {
              handlers.onRemoveAttachment?.(item.id);
            },
          }, icon("x", 12)),
        );
        attachments.append(chip);
      }
    },
    setDisabled(next: boolean) {
      disabled = next;
      if (next) {
        setPlusOpen(false);
        setProviderOpen(false);
      }
      applyDisabled();
    },
    setLocked(next: boolean) {
      locked = next;
      if (next) setProviderOpen(false);
      providerMenu.classList.toggle("is-locked", next);
      lockedHint.hidden = !next;
      applyDisabled();
    },
    setRunning(next: boolean) {
      // Legacy boolean entry — pure stop/send appearance (Mac setStopMode
      // without options). Fine-grained queue states go through setStopMode.
      setStopModeFn(next);
    },
    /**
     * Mac TaskComposerView.setStopMode parity: `stop` swaps the glyph to Stop;
     * otherwise `steer` relabels the send button "Queue for after this turn"
     * (submitting while a turn runs enqueues / promotes instead of stopping).
     */
    setStopMode: setStopModeFn,
    setSendDisabled(next: boolean) {
      sendDisabled = next;
      applyDisabled();
    },
  };
}
