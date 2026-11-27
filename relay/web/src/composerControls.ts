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
  onProviderMenuOpen?: () => void;
  onReasoningEffortSelect?: (level: ComposerReasoningEffort) => void;
  onToggleInfinite?: (next: boolean) => void;
  onToggleBypass?: (next: boolean) => void;
  onSend?: () => void;
  onStop?: () => void;
}

export interface ComposerToolbarConfig {
  providers: readonly ComposerProviderOption[];
  state: ComposerControlsState;
  bypassAvailable: boolean;
  providerFallbackLabel?: string | null;
  providerSelectable?: boolean;
}

export interface ComposerToolbar {
  root: HTMLElement;
  attachments: HTMLElement;
  sendWrap: HTMLElement;
  setState(patch: Partial<ComposerControlsState>): void;
  setItems(items: readonly ComposerAttachmentItem[]): void;
  setProviders(next: readonly ComposerProviderOption[]): void;
  setDisabled(disabled: boolean): void;
  setLocked(locked: boolean): void;
  setRunning(running: boolean): void;
  setStopMode(stop: boolean, opts?: { steer?: boolean }): void;
  setSendDisabled(disabled: boolean): void;
}

function attachmentIcon(kind: string): string {
  return kind === "image" ? "image" : "file";
}

function menuChrome(extraClass: string): HTMLElement {
  return el("div", { class: `composer-menu ${extraClass}`, hidden: true });
}

export function buildComposerToolbar(
  config: ComposerToolbarConfig,
  handlers: ComposerToolbarHandlers,
): ComposerToolbar {
  const state: ComposerControlsState = { ...config.state };
  if (!isComposerReasoningEffort(state.reasoningEffort)) {
    (state as { reasoningEffort?: unknown }).reasoningEffort = "low";
  }
  let providers = [...config.providers];
  let disabled = false;
  let locked = false;
  let running = false;
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

  const attachments = el("div", { class: "composer-attachments", "aria-label": "Attachments", hidden: true });

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
    effortSeg.dataset.level = level;
    effortButtons.forEach((b, i) => b.setAttribute("aria-checked", i === safe ? "true" : "false"));
    paintStepper(safe);
  };

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
      void stepValue.offsetWidth;
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
    providerBtn.disabled = disabled;
    for (const btn of sessionControls()) btn.disabled = disabled || locked;
    const index = COMPOSER_EFFORT_LEVELS.findIndex((l) => l.id === state.reasoningEffort);
    const safe = index < 0 ? 1 : index;
    stepMinus.disabled = disabled || locked || safe === 0;
    stepPlus.disabled = disabled || locked || safe === COMPOSER_EFFORT_LEVELS.length - 1;
    for (const btn of providerList.querySelectorAll("button")) btn.disabled = disabled || locked;
    sendBtn.disabled = disabled || (running || queueSubmit ? false : sendDisabled);
    root.classList.toggle("is-disabled", disabled);
  };

  const setStopModeFn = (stop: boolean, opts?: { steer?: boolean }) => {
    running = stop;
    queueSubmit = !stop && opts?.steer === true;
    sendWrap.classList.toggle("is-running", stop);
    sendBtn.classList.toggle("is-stop", stop);
    sendBtn.classList.toggle("is-queue", queueSubmit);
    const label = stop ? "Stop" : queueSubmit ? "Queue for after this turn" : "Send";
    sendBtn.setAttribute("aria-label", label);
    sendBtn.title = label;
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
      setStopModeFn(next);
    },
    setStopMode: setStopModeFn,
    setSendDisabled(next: boolean) {
      sendDisabled = next;
      applyDisabled();
    },
  };
}
