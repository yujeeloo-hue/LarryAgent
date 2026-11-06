import { isImeComposing } from "./ime.js";
import { modelMatchesQuery } from "./providerWizardFilter.js";
import { normalizeLlmBaseUrl, resolveLlmApiProtocol, type LlmApiProtocol } from "../../../llm/apiProtocol.js";
import { createBrandIcon, matchModelBrand } from "./modelBrand.js";
import {
  Check,
  ChevronRight,
  Eye,
  EyeOff,
  LoaderCircle,
  Lock,
  Search,
  TriangleAlert,
  X,
  createLucideIcon,
} from "./icons.js";
import "./provider-wizard.css";

/**
 * Provider setup wizard (demo-approved layout, provider-wizard-demo 20260929).
 *
 * Step 1 "Connect": base URL + API key → main-process `llm:probeModels`
 * (GET {base}/models with /v1 retry). Step 2 "Select models": probed ids as
 * checkboxes — all unchecked by default, non-chat models (embedding /
 * reranker / audio) collapsed into a group row, ids that already exist as
 * profiles render as "Added" and stay unselectable. The list has a filter
 * field — every word must appear in the model id — so large catalogues
 * stay usable. "Manual add…" is the
 * escape hatch for gateways without a /models route.
 *
 * Resolves with the picked { baseUrl, apiKey, models } for the caller to
 * persist (one model = one provider profile), or null when cancelled.
 */

export type ProviderWizardPick = {
  apiProtocol: LlmApiProtocol;
  rawEndpoint?: boolean;
  /** Normalized base URL (no trailing slash). */
  baseUrl: string;
  /** Trimmed API key; may be "" for local servers. */
  apiKey: string;
  /** Selected model ids (≥1). */
  models: string[];
};

export type ProviderWizardOptions = {
  /** Existing chat profiles — baseUrl+modelId matches render as "Added". */
  existingProviders?: ReadonlyArray<{ baseUrl: string; modelId: string }>;
};

/* ---- pure helpers (exported for tests) ---- */

/** Non-chat model families hidden behind the collapsed group row. */
const NON_CHAT_MATCHERS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /rerank/, label: "reranker" },
  { re: /moderation/, label: "moderation" },
  { re: /embed|bge/, label: "embedding" },
  { re: /tts|asr|speech|voice|audio|whisper/, label: "audio" },
];

/** Classify a model id as non-chat (returns the family label) or null. */
export function classifyNonChatModel(modelId: string): string | null {
  const id = modelId.toLowerCase();
  for (const matcher of NON_CHAT_MATCHERS) {
    if (matcher.re.test(id)) return matcher.label;
  }
  return null;
}

/** Short display name for a wizard-added profile: last path segment of the
 * model id ("deepseek-ai/DeepSeek-V3" → "DeepSeek-V3"). Shared by the
 * Settings entry and the standalone (startup / error-card) flows. */
export function providerDisplayName(modelId: string): string {
  const segment = modelId.split("/").pop() ?? modelId;
  return segment.trim() || modelId;
}

function normalizeBaseForCompare(baseUrl: string): string {
  return normalizeLlmBaseUrl(baseUrl).toLowerCase();
}

function hostLabelOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

/** Renderer-side mirror of the main-process probe reason → user copy. */
export function probeErrorMessage(reason: string): string {
  switch (reason) {
    case "invalid_url":
      return "Enter a valid http(s) base URL.";
    case "missing_key":
      return "API key required — local servers can leave it empty.";
    case "network":
      return "Could not reach the host — check the URL or your network.";
    case "bad_payload":
    case "no_models":
      return "The gateway answered but listed no usable models — try Manual add.";
    case "http_401":
      return "HTTP 401 Unauthorized — check the API key and try again.";
    case "http_403":
      return "HTTP 403 Forbidden — the key lacks access to this gateway.";
    case "http_404":
    case "http_405":
      return "No /models route on this gateway — use Manual add.";
    case "http_429":
      return "HTTP 429 — rate limited, retry in a moment.";
    default: {
      const match = /^http_(\d+)$/.exec(reason);
      if (match) {
        const status = Number(match[1]);
        if (status >= 500) {
          return `HTTP ${status} — gateway error, try again later.`;
        }
        return `HTTP ${status} — detection failed.`;
      }
      return "Detection failed — try again or use Manual add.";
    }
  }
}

type Page = "connect" | "list" | "manual";

export function showProviderWizard(
  options: ProviderWizardOptions = {},
): Promise<ProviderWizardPick | null> {
  return new Promise((resolve) => {
    const existing = new Set(
      (options.existingProviders ?? []).map(
        (p) =>
          `${normalizeBaseForCompare(p.baseUrl)}::${p.modelId.trim().toLowerCase()}`,
      ),
    );

    /* ---- state ---- */
    let models: string[] = [];
    const selected = new Set<string>();
    let query = "";
    let showOther = false;
    let probing = false;
    let lastBaseUrl = "";
    let settled = false;
    let apiProtocol: LlmApiProtocol = "auto";
    let rawEndpoint = false;

    /* ---- element helpers ---- */
    const div = (cls: string): HTMLDivElement => {
      const el = document.createElement("div");
      el.className = cls;
      return el;
    };
    const span = (cls: string): HTMLSpanElement => {
      const el = document.createElement("span");
      el.className = cls;
      return el;
    };
    const makeBtn = (label: string, cls = "pw-btn"): HTMLButtonElement => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = cls;
      el.textContent = label;
      return el;
    };
    const makeInput = (
      type: "text" | "password",
      placeholder: string,
    ): HTMLInputElement => {
      const el = document.createElement("input");
      el.type = type;
      el.className = "pw-input";
      el.placeholder = placeholder;
      el.spellcheck = false;
      el.autocomplete = type === "password" ? "new-password" : "off";
      return el;
    };
    const makeField = (
      labelText: string,
      control: HTMLElement,
      hint?: HTMLElement,
    ): HTMLElement => {
      const field = div("pw-field");
      const label = span("pw-label");
      label.textContent = labelText;
      field.append(label, control);
      if (hint) field.append(hint);
      return field;
    };

    /* ---- dialog shell ---- */
    const overlay = div("pw-overlay");
    overlay.setAttribute("role", "presentation");

    const dialog = div("pw-dialog");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "pw-wizard-title");

    const titlebar = div("pw-titlebar");
    const title = document.createElement("h2");
    title.id = "pw-wizard-title";
    title.className = "pw-title";
    title.textContent = "Add Provider";
    const closeBtn = makeBtn("", "pw-close");
    closeBtn.setAttribute("aria-label", "Close");
    closeBtn.append(createLucideIcon(X, { size: 14 }));
    titlebar.append(title, closeBtn);

    const steps = div("pw-steps");
    const step1 = div("pw-step");
    const step1Num = span("pw-step-num");
    step1Num.textContent = "1";
    step1.append(step1Num, document.createTextNode("Connect"));
    const step2 = div("pw-step");
    const step2Num = span("pw-step-num");
    step2Num.textContent = "2";
    step2.append(step2Num, document.createTextNode("Select models"));
    const stepArrow = span("pw-step-arrow");
    stepArrow.append(createLucideIcon(ChevronRight, { size: 14 }));
    steps.append(step1, stepArrow, step2);

    /* ---- page: connect ---- */
    const pageConnect = div("pw-page");

    const baseUrlInput = makeInput("text", "https://api.deepseek.com/v1");
    const protocolSelect = document.createElement("select");
    protocolSelect.className = "pw-input";
    protocolSelect.setAttribute("aria-label", "API protocol");
    for (const [value, label] of [["auto", "Auto (from URL)"], ["chat_completions", "Chat Completions"], ["responses", "Responses"]]) {
      const option = document.createElement("option");
      option.value = value!;
      option.textContent = label!;
      protocolSelect.append(option);
    }
    const protocolHint = span("pw-hint");
    const rawEndpointInput = document.createElement("input");
    rawEndpointInput.type = "checkbox";
    rawEndpointInput.setAttribute("aria-label", "Full endpoint URL");
    const rawEndpointRow = document.createElement("label");
    rawEndpointRow.className = "pw-hint";
    rawEndpointRow.append(rawEndpointInput, document.createTextNode("Full endpoint URL — use exactly as entered"));
    rawEndpointInput.addEventListener("change", () => {
      rawEndpoint = rawEndpointInput.checked;
      manualRawEndpointInput.checked = rawEndpoint;
    });
    const refreshProtocolHint = (): void => {
      const protocol = resolveLlmApiProtocol({ baseUrl: baseUrlInput.value, apiProtocol });
      protocolHint.textContent = `${apiProtocol === "auto" ? "Auto: " : "Selected: "}${protocol === "responses" ? "Responses" : "Chat Completions"}. Auto uses the URL only; no model request is sent.`;
    };
    baseUrlInput.addEventListener("input", refreshProtocolHint);
    protocolSelect.addEventListener("change", () => {
      apiProtocol = protocolSelect.value as LlmApiProtocol;
      manualProtocolSelect.value = apiProtocol;
      refreshProtocolHint();
      refreshManualProtocolHint();
    });
    refreshProtocolHint();

    const apiKeyInput = makeInput(
      "password",
      "sk-…  (local servers: leave empty)",
    );
    const apiKeyWrap = div("pw-input-wrap");
    const eyeBtn = makeBtn("", "pw-input-icon");
    eyeBtn.tabIndex = -1;
    let keyRevealed = false;
    const setKeyRevealed = (value: boolean): void => {
      keyRevealed = value;
      apiKeyInput.type = value ? "text" : "password";
      eyeBtn.replaceChildren(
        createLucideIcon(value ? EyeOff : Eye, { size: 14 }),
      );
      eyeBtn.setAttribute("aria-label", value ? "Hide API key" : "Show API key");
    };
    eyeBtn.addEventListener("mousedown", (event) => event.preventDefault());
    eyeBtn.addEventListener("click", () => setKeyRevealed(!keyRevealed));
    setKeyRevealed(false);
    apiKeyWrap.append(apiKeyInput, eyeBtn);

    const keyHint = document.createElement("p");
    keyHint.className = "pw-hint";
    keyHint.append(createLucideIcon(Lock, { size: 11 }));
    const keyHintText = span("");
    keyHintText.textContent =
      "Encrypted on this device (safeStorage) — never written to settings.json.";
    keyHint.append(keyHintText);

    const errorBanner = div("pw-error");
    errorBanner.hidden = true;
    errorBanner.append(createLucideIcon(TriangleAlert, { size: 14 }));
    const errorText = span("pw-error-text");
    const retryBtn = makeBtn("Retry", "pw-retry");
    errorBanner.append(errorText, retryBtn);

    const actionsConnect = div("pw-actions");
    const manualAddBtn = makeBtn("Manual add…", "pw-linkbtn");
    const cancelBtn = makeBtn("Cancel");
    const detectBtn = makeBtn("Detect models", "pw-btn pw-btn-primary action-primary");
    actionsConnect.append(
      manualAddBtn,
      div("pw-spacer"),
      cancelBtn,
      detectBtn,
    );

    pageConnect.append(
      makeField("Base URL", baseUrlInput),
      makeField("API protocol", protocolSelect, protocolHint),
      rawEndpointRow,
      makeField("API Key", apiKeyWrap, keyHint),
      errorBanner,
      actionsConnect,
    );

    /* ---- page: model list (also hosts the detecting state) ---- */
    const pageList = div("pw-page");

    const searchInput = makeInput("text", "Filter models…");
    searchInput.setAttribute("aria-label", "Filter models");
    const searchWrap = div("pw-input-wrap pw-search");
    const searchIcon = span("pw-search-icon");
    searchIcon.append(createLucideIcon(Search, { size: 14 }));
    const searchClearBtn = makeBtn("", "pw-input-icon");
    searchClearBtn.tabIndex = -1;
    searchClearBtn.setAttribute("aria-label", "Clear search");
    searchClearBtn.append(createLucideIcon(X, { size: 14 }));
    searchClearBtn.style.display = "none";
    searchWrap.append(searchIcon, searchInput, searchClearBtn);

    const listEl = div("pw-list");

    const actionsList = div("pw-actions");
    const selectAllBtn = makeBtn("Select all", "pw-linkbtn");
    const clearSelBtn = makeBtn("Clear", "pw-linkbtn");
    const countEl = span("pw-count");
    const addBtn = makeBtn("Add 0 providers", "pw-btn pw-btn-primary action-primary");
    addBtn.disabled = true;
    actionsList.append(
      selectAllBtn,
      clearSelBtn,
      div("pw-spacer"),
      countEl,
      addBtn,
    );

    pageList.append(searchWrap, listEl, actionsList);

    /* ---- page: manual add ---- */
    const pageManual = div("pw-page");
    const manualBaseUrl = makeInput("text", "https://api.deepseek.com/v1");
    const manualModelId = makeInput("text", "deepseek-chat");
    const manualApiKey = makeInput(
      "password",
      "sk-…  (local servers: leave empty)",
    );
    const manualErrorBanner = div("pw-error");
    const manualProtocolSelect = protocolSelect.cloneNode(true) as HTMLSelectElement;
    const manualProtocolHint = span("pw-hint");
    const manualRawEndpointInput = rawEndpointInput.cloneNode(true) as HTMLInputElement;
    const manualRawEndpointRow = document.createElement("label");
    manualRawEndpointRow.className = "pw-hint";
    manualRawEndpointRow.append(manualRawEndpointInput, document.createTextNode("Full endpoint URL — use exactly as entered"));
    manualRawEndpointInput.addEventListener("change", () => {
      rawEndpoint = manualRawEndpointInput.checked;
      rawEndpointInput.checked = rawEndpoint;
    });
    const refreshManualProtocolHint = (): void => {
      const protocol = resolveLlmApiProtocol({ baseUrl: manualBaseUrl.value, apiProtocol });
      manualProtocolHint.textContent = `${apiProtocol === "auto" ? "Auto: " : "Selected: "}${protocol === "responses" ? "Responses" : "Chat Completions"}`;
    };
    manualBaseUrl.addEventListener("input", refreshManualProtocolHint);
    manualProtocolSelect.addEventListener("change", () => {
      apiProtocol = manualProtocolSelect.value as LlmApiProtocol;
      protocolSelect.value = apiProtocol;
      refreshProtocolHint();
      refreshManualProtocolHint();
    });
    refreshManualProtocolHint();
    manualErrorBanner.hidden = true;
    manualErrorBanner.append(createLucideIcon(TriangleAlert, { size: 14 }));
    const manualErrorText = span("pw-error-text");
    manualErrorBanner.append(manualErrorText);
    const manualBackBtn = makeBtn("Back");
    const manualCancelBtn = makeBtn("Cancel");
    const manualAddConfirmBtn = makeBtn(
      "Add provider",
      "pw-btn pw-btn-primary action-primary",
    );
    const actionsManual = div("pw-actions");
    actionsManual.append(
      manualBackBtn,
      div("pw-spacer"),
      manualCancelBtn,
      manualAddConfirmBtn,
    );
    pageManual.append(
      makeField("Base URL", manualBaseUrl),
      makeField("API protocol", manualProtocolSelect, manualProtocolHint),
      manualRawEndpointRow,
      makeField("Model ID", manualModelId),
      makeField("API Key", manualApiKey),
      manualErrorBanner,
      actionsManual,
    );

    /* ---- state plumbing ---- */
    const isDupe = (model: string): boolean =>
      existing.has(`${normalizeBaseForCompare(lastBaseUrl)}::${model.toLowerCase()}`);
    const selectableModels = (): string[] => models.filter((m) => !isDupe(m));

    /** Rows actually painted: query matches, with collapsed non-chat hidden. */
    const listedModels = (): string[] =>
      models.filter((model) => {
        if (!modelMatchesQuery(model, query)) return false;
        if (!classifyNonChatModel(model)) return true;
        return query.trim().length > 0 || showOther;
      });

    const updateFooter = (): void => {
      const n = selected.size;
      if (query.trim()) {
        const shown = listedModels().filter((model) => !isDupe(model));
        const shownSelected = shown.filter((model) => selected.has(model)).length;
        countEl.textContent = `${shownSelected} of ${shown.length} matches`;
      } else {
        countEl.textContent = `${n} of ${selectableModels().length} selected`;
      }
      addBtn.textContent = `Add ${n} ${n === 1 ? "provider" : "providers"}`;
      addBtn.disabled = n === 0;
    };

    const setListBusy = (busy: boolean): void => {
      searchInput.disabled = busy;
      selectAllBtn.disabled = busy;
      clearSelBtn.disabled = busy;
      if (busy) {
        addBtn.disabled = true;
        countEl.textContent = "";
      } else {
        updateFooter();
      }
    };

    const fallbackBadge = (model: string): HTMLElement => {
      const seg = model.includes("/") ? (model.split("/").pop() ?? model) : model;
      const ch = (seg.trim()[0] ?? "?").toUpperCase();
      const el = span("pw-brand-fallback");
      el.textContent = ch;
      return el;
    };

    const buildRow = (model: string, kind: string | null): HTMLElement => {
      const row = div("pw-row");
      row.setAttribute("role", "checkbox");
      const check = div("pw-check");
      check.append(createLucideIcon(Check, { size: 11, strokeWidth: 3 }));
      const brand = div("pw-brand");
      const brandKey = matchModelBrand({ baseUrl: lastBaseUrl, modelId: model });
      brand.append(
        brandKey ? createBrandIcon(brandKey, 18) : fallbackBadge(model),
      );
      const name = span("pw-model");
      name.append(document.createTextNode(model));
      if (kind) {
        const kindNote = span("pw-model-kind");
        kindNote.textContent = ` · ${kind}`;
        name.append(kindNote);
      }
      row.append(check, brand, name);

      if (isDupe(model)) {
        row.classList.add("sel", "disabled");
        row.setAttribute("aria-checked", "true");
        row.setAttribute("aria-disabled", "true");
        const chip = span("pw-chip");
        chip.textContent = "Added";
        row.append(chip);
        return row;
      }
      if (selected.has(model)) row.classList.add("sel");
      row.setAttribute("aria-checked", selected.has(model) ? "true" : "false");
      row.addEventListener("click", () => {
        if (selected.has(model)) selected.delete(model);
        else selected.add(model);
        renderList();
        updateFooter();
      });
      return row;
    };

    const buildGroupRow = (count: number): HTMLElement => {
      const group = div("pw-group");
      if (showOther) group.classList.add("open");
      const chev = span("pw-chev");
      chev.append(createLucideIcon(ChevronRight, { size: 14 }));
      const label = span("pw-group-label");
      label.textContent = `Other models (${count})`;
      const sub = span("pw-group-sub");
      const kinds = new Set(
        models
          .map((m) => classifyNonChatModel(m))
          .filter((k): k is string => k !== null),
      );
      sub.textContent = kinds.size > 0
        ? `${[...kinds].join(" · ")} — hidden by default`
        : "hidden by default";
      const toggle = makeBtn(showOther ? "Hide" : "Show all", "pw-linkbtn");
      group.append(chev, label, sub, toggle);
      group.addEventListener("click", () => {
        showOther = !showOther;
        renderList();
      });
      return group;
    };

    const buildLoadingRow = (baseUrl: string): HTMLElement => {
      const el = div("pw-loading");
      const spinner = createLucideIcon(LoaderCircle, { size: 18 });
      spinner.classList.add("pw-spin");
      const text = span("");
      text.append("Fetching models from ");
      const host = span("pw-loading-host");
      host.textContent = hostLabelOf(baseUrl);
      text.append(host, "…");
      el.append(spinner, text);
      return el;
    };

    const renderList = (): void => {
      listEl.replaceChildren();
      const q = query.trim();
      const chatRows: HTMLElement[] = [];
      const otherRows: HTMLElement[] = [];
      for (const model of models) {
        if (!modelMatchesQuery(model, q)) continue;
        const kind = classifyNonChatModel(model);
        const row = buildRow(model, kind);
        (kind ? otherRows : chatRows).push(row);
      }
      listEl.append(...chatRows);
      if (otherRows.length > 0) {
        if (!q) listEl.append(buildGroupRow(otherRows.length));
        if (q || showOther) listEl.append(...otherRows);
      }
      if (q && chatRows.length === 0 && otherRows.length === 0) {
        const empty = div("pw-empty");
        empty.textContent = "No matches";
        listEl.append(empty);
      }
    };

    const setPage = (page: Page): void => {
      pageConnect.hidden = page !== "connect";
      pageList.hidden = page !== "list";
      pageManual.hidden = page !== "manual";
      steps.hidden = page === "manual";
      title.textContent =
        page === "manual" ? "Add Provider — Manual" : "Add Provider";
      step1.classList.toggle("on", page !== "manual");
      step2.classList.toggle("on", page === "list");
      if (page === "connect") {
        requestAnimationFrame(() => baseUrlInput.focus());
      } else if (page === "manual") {
        requestAnimationFrame(() => manualModelId.focus());
      }
    };

    const finish = (value: ProviderWizardPick | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      window.removeEventListener("keydown", onKeyDown, true);
      resolve(value);
    };

    const showError = (message: string): void => {
      errorText.textContent = message;
      errorBanner.hidden = false;
    };

    const runDetect = (): void => {
      if (probing) return;
      errorBanner.hidden = true;
      const base = normalizeLlmBaseUrl(baseUrlInput.value, rawEndpoint);
      const key = apiKeyInput.value.trim();
      if (!base || !/^https?:\/\//i.test(base)) {
        showError(probeErrorMessage("invalid_url"));
        return;
      }
      if (!key && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(base)) {
        showError(probeErrorMessage("missing_key"));
        return;
      }
      const bridge = window.jellybot;
      if (!bridge || typeof bridge.probeLlmModels !== "function") {
        showError("Detection is unavailable in this build — use Manual add.");
        return;
      }
      probing = true;
      lastBaseUrl = base;
      setPage("list");
      setListBusy(true);
      listEl.replaceChildren(buildLoadingRow(base));
      void bridge
        .probeLlmModels({ baseUrl: base, apiKey: key })
        .then((result) => {
          probing = false;
          if (settled) return;
          if (!result.ok) {
            setListBusy(false);
            setPage("connect");
            showError(probeErrorMessage(result.reason));
            return;
          }
          models = result.models;
          selected.clear();
          query = "";
          showOther = false;
          searchInput.value = "";
          searchClearBtn.style.display = "none";
          renderList();
          setListBusy(false);
          requestAnimationFrame(() => searchInput.focus());
        });
    };

    const submitManual = (): void => {
      const base = normalizeLlmBaseUrl(manualBaseUrl.value, rawEndpoint);
      const modelId = manualModelId.value.trim();
      const key = manualApiKey.value.trim();
      manualErrorBanner.hidden = true;
      if (!base || !/^https?:\/\//i.test(base)) {
        manualErrorText.textContent = "Enter a valid http(s) base URL.";
        manualErrorBanner.hidden = false;
        return;
      }
      if (!modelId) {
        manualErrorText.textContent = "Enter the model id.";
        manualErrorBanner.hidden = false;
        return;
      }
      finish({ baseUrl: base, apiKey: key, models: [modelId], apiProtocol, ...(rawEndpoint ? { rawEndpoint: true } : {}) });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    };
    const connectSubmitKey = (event: KeyboardEvent): void => {
      if (event.key === "Enter" && !isImeComposing(event)) {
        event.preventDefault();
        event.stopPropagation();
        runDetect();
      }
    };
    const manualSubmitKey = (event: KeyboardEvent): void => {
      if (event.key === "Enter" && !isImeComposing(event)) {
        event.preventDefault();
        event.stopPropagation();
        submitManual();
      }
    };

    /* ---- wiring ---- */
    closeBtn.addEventListener("click", () => finish(null));
    cancelBtn.addEventListener("click", () => finish(null));
    manualCancelBtn.addEventListener("click", () => finish(null));
    retryBtn.addEventListener("click", () => runDetect());
    detectBtn.addEventListener("click", () => runDetect());
    baseUrlInput.addEventListener("keydown", connectSubmitKey);
    apiKeyInput.addEventListener("keydown", connectSubmitKey);

    manualAddBtn.addEventListener("click", () => {
      manualBaseUrl.value = baseUrlInput.value.trim();
      refreshManualProtocolHint();
      manualApiKey.value = apiKeyInput.value;
      manualErrorBanner.hidden = true;
      setPage("manual");
    });
    manualBackBtn.addEventListener("click", () => setPage("connect"));
    manualAddConfirmBtn.addEventListener("click", () => submitManual());
    manualBaseUrl.addEventListener("keydown", manualSubmitKey);
    manualModelId.addEventListener("keydown", manualSubmitKey);
    manualApiKey.addEventListener("keydown", manualSubmitKey);

    searchInput.addEventListener("input", () => {
      query = searchInput.value;
      searchClearBtn.style.display = query ? "grid" : "none";
      renderList();
      updateFooter();
    });
    searchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") event.preventDefault();
    });
    searchClearBtn.addEventListener("click", () => {
      searchInput.value = "";
      query = "";
      searchClearBtn.style.display = "none";
      renderList();
      updateFooter();
      searchInput.focus();
    });
    selectAllBtn.addEventListener("click", () => {
      for (const model of listedModels()) {
        if (!isDupe(model)) selected.add(model);
      }
      renderList();
      updateFooter();
    });
    clearSelBtn.addEventListener("click", () => {
      selected.clear();
      renderList();
      updateFooter();
    });
    addBtn.addEventListener("click", () => {
      if (selected.size === 0) return;
      finish({
        baseUrl: lastBaseUrl,
        apiKey: apiKeyInput.value.trim(),
        models: [...selected],
        apiProtocol,
        ...(rawEndpoint ? { rawEndpoint: true } : {}),
      });
    });

    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) finish(null);
    });
    window.addEventListener("keydown", onKeyDown, true);

    /* ---- mount ---- */
    dialog.append(titlebar, steps, pageConnect, pageList, pageManual);
    overlay.append(dialog);
    setPage("connect");
    updateFooter();
    document.body.append(overlay);
  });
}
