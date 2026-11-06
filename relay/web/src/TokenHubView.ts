import { icon } from "./icons.js";
import { cardHeaderIcon } from "./cardHeaderIcons.js";
import { bindProviderReorder, syncProviderRows } from "./tokenHubReorder.js";
import { normalizeProviderBaseUrl } from "./TokenHubController.js";
import { resolveResponsesStateful } from "./providerApiOptions.js";
import {
  HOSTED_TOOL_FAMILIES,
  normalizeToolsArray,
  parseHostedToolsJson,
  setToolEnabled,
  toolEnabled,
} from "./hostedTools.js";
import type {
  DetectedTokenHubModel,
  TokenHubController,
  TokenHubModel,
  TokenHubProvider,
  TokenHubSnapshot,
} from "./TokenHubController.js";
import {
  createBrandIcon,
  matchModelBrand,
} from "../../../src/renderer/src/ui/modelBrand.js";
// token-hub.css is imported by main.ts so this module stays DOM-testable
// under node:test (no CSS pipeline there).

type AttrValue = string | boolean | undefined | ((event: Event) => void);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "function") node.addEventListener(key.replace(/^on/, ""), value as EventListener);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else if (value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === "string") {
      if (child.startsWith("<svg")) {
        const template = document.createElement("template");
        template.innerHTML = child;
        node.append(template.content);
      } else node.append(document.createTextNode(child));
    } else node.append(child);
  }
  return node;
}

function switchControl(checked: boolean, label: string, onChange: (checked: boolean) => void): HTMLElement {
  const input = h("input", { type: "checkbox", "aria-label": label }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "th-switch" }, input, h("span", { class: "th-switch-track" }));
}

function statusChip(label: string, kind: "ok" | "warn" | "muted"): HTMLElement {
  return h("span", { class: `th-status is-${kind}` }, label);
}

function reportFailure(reason: unknown): void {
  window.alert(reason instanceof Error ? reason.message : String(reason));
}

export function openAddProviderWizard(controller: TokenHubController): void {
  showAddProviderWizard(controller);
}

function showAddProviderWizard(controller: TokenHubController): void {
  const overlay = h("div", { class: "th-overlay" });
  const dialog = h("div", {
    class: "th-dialog",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Add LLM Provider Hub provider",
  });
  const title = h("h2", { class: "th-dialog-title" }, "Add Provider");
  const close = h("button", { class: "th-icon-btn", type: "button", "aria-label": "Close" }, icon("x", 14));
  const titlebar = h("div", { class: "th-dialog-head" }, title, close);
  const steps = h("div", { class: "th-steps" },
    h("span", { class: "th-step is-on" }, h("i", {}, "1"), "Connect"),
    icon("chevronRight", 13),
    h("span", { class: "th-step" }, h("i", {}, "2"), "Select models"),
  );
  const page = h("div", { class: "th-dialog-page" });
  dialog.append(titlebar, steps, page);
  overlay.append(dialog);
  document.body.append(overlay);

  let detected: DetectedTokenHubModel[] = [];
  const chosen = new Map<string, TokenHubModel>();
  let baseUrl = "";
  let apiKey = "";
  let apiProtocol: "auto" | "chat_completions" | "responses" = "auto";
  // Keep-state is opt-in; an untouched switch still follows the shared
  // resolver so desktop and relay cannot drift apart.
  let responsesStateful = false;
  let statefulTouched = false;

  const finish = () => {
    overlay.remove();
    window.removeEventListener("keydown", onKeyDown, true);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") finish();
  };
  close.addEventListener("click", finish);
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay) finish();
  });
  window.addEventListener("keydown", onKeyDown, true);

  const field = (label: string, input: HTMLElement, hint?: string) =>
    h("label", { class: "th-field" },
      h("span", { class: "th-field-label" }, label),
      input,
      hint ? h("span", { class: "th-field-hint" }, hint) : null);

  const renderConnect = () => {
    steps.querySelectorAll(".th-step")[0]?.classList.add("is-on");
    steps.querySelectorAll(".th-step")[1]?.classList.remove("is-on");
    const urlInput = h("input", {
      class: "th-input",
      type: "text",
      placeholder: "https://api.openai.com/v1",
      value: baseUrl,
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const keyInput = h("input", {
      class: "th-input",
      type: "password",
      placeholder: "sk-…  (local servers: leave empty)",
      value: apiKey,
      autocomplete: "new-password",
    }) as HTMLInputElement;
    const eye = h("button", { class: "th-input-action", type: "button", "aria-label": "Show API key" }, icon("eye", 14));
    eye.addEventListener("click", () => {
      const reveal = keyInput.type === "password";
      keyInput.type = reveal ? "text" : "password";
      eye.innerHTML = icon(reveal ? "eyeOff" : "eye", 14);
      eye.setAttribute("aria-label", reveal ? "Hide API key" : "Show API key");
    });
    const keyWrap = h("div", { class: "th-input-wrap" }, keyInput, eye);
    const protocolSelect = h("select", {
      class: "th-input th-mode-select",
      "aria-label": "API protocol",
    }) as HTMLSelectElement;
    protocolSelect.replaceChildren(
      h("option", { value: "auto" }, "Auto (from URL)"),
      h("option", { value: "chat_completions" }, "Chat Completions"),
      h("option", { value: "responses" }, "Responses"),
    );
    protocolSelect.value = apiProtocol;
    const statefulInput = h("input", { type: "checkbox", "aria-label": "Keep Responses conversation state" }) as HTMLInputElement;
    statefulInput.checked = responsesStateful;
    statefulInput.addEventListener("change", () => {
      responsesStateful = statefulInput.checked;
      statefulTouched = true;
    });
    const statefulRow = h("div", { class: "th-detail-capability-row" },
      h("div", {},
        h("div", { class: "th-field-label" }, "Keep Responses conversation state"),
        h("div", { class: "th-field-hint" }, "Reuse server-side conversation state (store + previous_response_id). Turn off for stateless gateways.")),
      h("label", { class: "th-switch" }, statefulInput, h("span", { class: "th-switch-track" })));
    const syncWizardResponses = () => {
      const responses = protocolSelect.value === "responses"
        || (protocolSelect.value === "auto" && /\/responses([/?#]|$)/.test(urlInput.value.trim()));
      statefulRow.hidden = !responses;
      if (!statefulTouched) {
        responsesStateful = resolveResponsesStateful({ baseUrl: urlInput.value.trim() });
        statefulInput.checked = responsesStateful;
      }
    };
    protocolSelect.addEventListener("change", () => {
      const value = protocolSelect.value;
      apiProtocol = value === "chat_completions" || value === "responses" ? value : "auto";
      syncWizardResponses();
    });
    urlInput.addEventListener("input", syncWizardResponses);
    const error = h("div", { class: "th-inline-error", hidden: true }, icon("warn", 13), h("span"));
    const detect = h("button", { class: "btn primary action-primary", type: "button" }, "Detect models") as HTMLButtonElement;
    const run = async () => {
      baseUrl = urlInput.value.trim();
      apiKey = keyInput.value.trim();
      detect.disabled = true;
      detect.setAttribute("aria-busy", "true");
      detect.replaceChildren(h("span", { class: "spinner th-button-spinner" }), "Detecting…");
      error.hidden = true;
      try {
        detected = await controller.detectModels(baseUrl, apiKey);
        renderModels();
      } catch (reason) {
        error.querySelector("span")!.textContent = reason instanceof Error ? reason.message : String(reason);
        error.hidden = false;
        detect.disabled = false;
        detect.removeAttribute("aria-busy");
        detect.textContent = "Detect models";
      }
    };
    detect.addEventListener("click", () => void run());
    for (const input of [urlInput, keyInput]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void run();
      });
    }
    page.replaceChildren(
      field("Base URL", urlInput),
      field("API Key", keyWrap, "Stored with AES-256-GCM in the relay database. The key is not shown again."),
      field("API protocol", h("span", { class: "th-mode-select-wrap" }, protocolSelect,
        h("span", { class: "th-mode-select-icon", "aria-hidden": "true" }, icon("chevronDown", 14)))),
      statefulRow,
      error,
      h("p", { class: "th-dialog-note" }, "The relay probes the gateway's /models endpoint — this can take a few seconds."),
      h("div", { class: "th-dialog-actions" },
        h("button", { class: "btn ghost", type: "button", onclick: finish }, "Cancel"),
        h("button", { class: "btn ghost action-primary", type: "button", onclick: () => { detected = []; renderModels(); } }, "Add manually"),
        detect),
    );
    syncWizardResponses();
    requestAnimationFrame(() => urlInput.focus());
  };

  const renderModels = () => {
    steps.querySelectorAll(".th-step")[0]?.classList.add("is-on");
    steps.querySelectorAll(".th-step")[1]?.classList.add("is-on");
    chosen.clear();
    const search = h("input", {
      class: "th-input th-search-input",
      type: "search",
      placeholder: "Filter models…",
      "aria-label": "Filter models",
    }) as HTMLInputElement;
    const rows = h("div", { class: "th-model-picker" });
    const count = h("span", { class: "th-selection-count" }, "0 selected");
    const addError = h("div", { class: "th-inline-error", hidden: true }, icon("warn", 13), h("span"));
    const add = h("button", { class: "btn primary action-primary", type: "button", disabled: true }, "Add 0 providers") as HTMLButtonElement;
    // Escape hatch for gateways with no usable /models route: type the id in.
    const manualId = h("input", {
      class: "th-input",
      type: "text",
      placeholder: "Add a model ID manually…",
      "aria-label": "Add model ID manually",
      spellcheck: "false",
      autocomplete: "off",
    }) as HTMLInputElement;
    const manualAdd = h("button", { class: "btn ghost action-primary", type: "button" }, "Add ID") as HTMLButtonElement;
    const submitManual = () => {
      const id = manualId.value.trim();
      manualId.value = "";
      if (!id) return;
      if (!detected.some((item) => item.id === id)) {
        detected.push({ id, supportsMultimodal: false });
      }
      paint();
    };
    manualAdd.addEventListener("click", submitManual);
    manualId.addEventListener("keydown", (event) => {
      const key = event as KeyboardEvent;
      if (key.key !== "Enter") return;
      key.preventDefault();
      submitManual();
    });

    const sync = () => {
      const total = chosen.size;
      count.textContent = `${total} selected`;
      add.textContent = `Add ${total} ${total === 1 ? "provider" : "providers"}`;
      add.disabled = total === 0;
    };
    const paint = () => {
      rows.replaceChildren();
      const query = search.value.trim().toLowerCase();
      for (const model of detected.filter((item) => item.id.toLowerCase().includes(query))) {
        const current = chosen.get(model.id);
        const checkbox = h("input", { type: "checkbox", "aria-label": `Select ${model.id}` }) as HTMLInputElement;
        checkbox.checked = Boolean(current);
        const row = h("div", { class: `th-picker-row${current ? " is-selected" : ""}` },
          checkbox,
          h("span", { class: "th-model-mark" }, model.id.slice(0, 1).toUpperCase()),
          h("span", { class: "th-picker-name" }, model.id),
          model.supportsMultimodal ? statusChip("Vision detected", "ok") : statusChip("Text", "muted"),
          switchControl(
            current?.supportsMultimodal ?? model.supportsMultimodal,
            `Multimodal for ${model.id}`,
            (enabled) => {
              if (!chosen.has(model.id)) {
                checkbox.checked = true;
                chosen.set(model.id, { id: model.id, supportsMultimodal: enabled, multimodalSource: "manual" });
              } else {
                chosen.set(model.id, { id: model.id, supportsMultimodal: enabled, multimodalSource: "manual" });
              }
              paint();
              sync();
            },
          ),
        );
        row.addEventListener("click", (event) => {
          if ((event.target as HTMLElement).closest(".th-switch")) return;
          if (chosen.has(model.id)) chosen.delete(model.id);
          else chosen.set(model.id, {
            id: model.id,
            supportsMultimodal: model.supportsMultimodal,
            multimodalSource: "detected",
          });
          paint();
          sync();
        });
        rows.append(row);
      }
      if (!rows.childElementCount) {
        rows.append(h("div", {
          class: "th-empty-row",
        }, detected.length ? "No matches" : "No models listed — add an ID below."));
      }
    };
    search.addEventListener("input", paint);
    // Optional auto-probe: two tiny Responses turns against the first chosen
    // model decide the explicit keep-state value for every added provider.
    const probeOnAdd = h("input", { type: "checkbox" }) as HTMLInputElement;
    const probeOnAddRow = h("label", { class: "th-probe-onadd" },
      probeOnAdd,
      h("span", {},
        "Probe Responses state support on add",
        h("span", { class: "th-field-hint" },
          "Sends two small requests before adding; the verdict becomes the saved Keep-state value.")));
    add.addEventListener("click", () => {
      add.disabled = true;
      add.setAttribute("aria-busy", "true");
      addError.hidden = true;
      const models = [...chosen.values()];
      const run = async () => {
        let stateful = responsesStateful;
        if (probeOnAdd.checked) {
          add.textContent = "Probing state support…";
          try {
            const result = await controller.probeWizardState({
              baseUrl,
              apiKey,
              modelId: models[0]!.id,
            });
            if (result.ok) stateful = result.supported;
          } catch {
            // Probe transport failure keeps the manually chosen value.
          }
        }
        add.textContent = `Add ${models.length} ${models.length === 1 ? "provider" : "providers"}`;
        await controller.addProviders({ baseUrl, apiKey, apiProtocol, responsesStateful: stateful, models });
        finish();
      };
      void run().catch((reason) => {
        addError.querySelector("span")!.textContent = reason instanceof Error ? reason.message : String(reason);
        addError.hidden = false;
        add.disabled = false;
        add.removeAttribute("aria-busy");
      });
    });
    paint();
    page.replaceChildren(
      h("div", { class: "th-search-wrap" }, icon("search", 14), search),
      rows,
      h("div", { class: "th-manual-row" }, manualId, manualAdd),
      addError,
      probeOnAddRow,
      h("div", { class: "th-dialog-actions" },
        h("button", { class: "th-link-btn", type: "button", onclick: () => {
          for (const model of detected) chosen.set(model.id, {
            id: model.id,
            supportsMultimodal: model.supportsMultimodal,
            multimodalSource: "detected",
          });
          paint();
          sync();
        } }, "Select all"),
        h("button", { class: "th-link-btn action-danger", type: "button", onclick: () => {
          chosen.clear();
          paint();
          sync();
        } }, "Clear"),
        h("span", { class: "spacer" }),
        count,
        h("button", { class: "btn ghost", type: "button", onclick: renderConnect }, "Back"),
        add),
    );
    requestAnimationFrame(() => search.focus());
  };

  renderConnect();
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return baseUrl;
  }
}

function providerListIcon(provider: TokenHubProvider): HTMLElement {
  const brand = matchModelBrand(provider);
  if (!brand) {
    return h("span", { class: "th-model-mark" }, provider.name.slice(0, 1).toUpperCase());
  }
  const brandIcon = createBrandIcon(brand, 14);
  brandIcon.classList.add("th-provider-brand");
  return brandIcon;
}

function providerList(snapshot: TokenHubSnapshot, controller: TokenHubController, status: HTMLElement): HTMLElement {
  const list = h("div", { class: "th-provider-list", role: "listbox", "aria-label": "LLM Providers" });
  for (const provider of snapshot.providers) {
    const selected = provider.id === snapshot.selectedProviderId;
    list.append(h("button", {
      class: `th-provider-row${selected ? " is-selected" : ""}`,
      type: "button",
      role: "option",
      "aria-selected": String(selected),
      "data-provider-id": provider.id,
      "aria-keyshortcuts": "Alt+ArrowUp Alt+ArrowDown",
      title: "Drag the grip to reorder · Alt+↑ / Alt+↓",
      onclick: () => controller.selectProvider(provider.id),
    },
      h("span", { class: "th-provider-grip", "aria-hidden": "true" }, icon("gripVertical", 13)),
      providerListIcon(provider),
      h("span", { class: "th-provider-copy" },
        h("span", { class: "th-provider-name" }, provider.name),
        providerMeta("th-provider-meta", provider.modelId, hostOf(provider.baseUrl), provider.baseUrl)),
      statusChip(provider.supportsMultimodal ? "Vision" : "Text", provider.supportsMultimodal ? "ok" : "muted"),
    ));
  }
  if (!snapshot.providers.length) {
    list.append(h("div", { class: "th-empty-row" }, "No LLM Providers yet."));
  }
  bindProviderReorder(list, status, controller);
  return list;
}

/** An order-only update must leave the detail editor's draft intact. */
export function syncTokenHubProviderOrder(container: HTMLElement, controller: TokenHubController): void {
  const list = container.querySelector<HTMLElement>(".th-provider-list");
  if (!list) return;
  syncProviderRows(list, controller.getSnapshot().providers.map((provider) => provider.id));
  list.setAttribute("aria-busy", String(controller.isProviderOrderSaving()));
}

/** Restore the Hub's position after Manage rebuilds its DOM on selection. */
export function captureTokenHubViewPosition(container: HTMLElement): () => void {
  const list = container.querySelector<HTMLElement>(".th-provider-list");
  const body = container.querySelector<HTMLElement>(".manage-body");
  const listTop = list?.scrollTop ?? 0;
  const bodyTop = body?.scrollTop ?? 0;
  const active = container.ownerDocument.activeElement as HTMLElement | null;
  const focusedId = active && list?.contains(active)
    ? active.closest<HTMLElement>(".th-provider-row")?.dataset.providerId : undefined;
  return () => {
    const nextList = container.querySelector<HTMLElement>(".th-provider-list");
    if (focusedId && nextList) {
      const row = [...nextList.querySelectorAll<HTMLButtonElement>(".th-provider-row")]
        .find((item) => item.dataset.providerId === focusedId);
      row?.focus({ preventScroll: true });
    }
    if (list && nextList) nextList.scrollTop = listTop;
    const nextBody = container.querySelector<HTMLElement>(".manage-body");
    if (body && nextBody) nextBody.scrollTop = bodyTop;
  };
}

function detailField(label: string, input: HTMLElement, wide = false, meta?: HTMLElement): HTMLElement {
  return h("label", { class: `th-detail-field${wide ? " is-wide" : ""}` },
    h("span", { class: "th-detail-label" }, label, meta),
    input);
}

function isMoonshotProviderBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === "api.moonshot.cn"
      || host.endsWith(".moonshot.cn")
      || host === "api.moonshot.ai"
      || host.endsWith(".moonshot.ai")
      || host === "api.kimi.com"
      || host.endsWith(".kimi.com");
  } catch {
    return false;
  }
}

function providerDetail(provider: TokenHubProvider, controller: TokenHubController): HTMLElement {
  const source = provider.multimodalSource === "manual" ? "Set manually" : "Detected automatically";
  const nameInput = h("input", {
    class: "th-input th-name-input",
    type: "text",
    value: provider.name,
    maxlength: "80",
    "aria-label": "Provider name",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const modelInput = h("input", {
    class: "th-input th-inline-input",
    type: "text",
    value: provider.modelId,
    maxlength: "200",
    "aria-label": "Model ID",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const urlInput = h("input", {
    class: "th-input th-inline-input",
    type: "text",
    value: provider.baseUrl,
    maxlength: "500",
    "aria-label": "Base URL",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const keyInput = h("input", {
    class: "th-input th-inline-input",
    type: "password",
    value: "",
    placeholder: provider.apiKeyConfigured ? "Leave blank to keep the existing key" : "Not set",
    autocomplete: "new-password",
    spellcheck: "false",
    "aria-label": "API key",
  }) as HTMLInputElement;
  const keyVisibility = h("button", {
    class: "th-input-action",
    type: "button",
    "aria-label": "Show new API key",
  }, icon("eye", 14));
  keyVisibility.addEventListener("click", () => {
    const reveal = keyInput.type === "password";
    keyInput.type = reveal ? "text" : "password";
    keyVisibility.innerHTML = icon(reveal ? "eyeOff" : "eye", 14);
    keyVisibility.setAttribute("aria-label", reveal ? "Hide new API key" : "Show new API key");
  });
  const keyWrap = h("span", { class: "th-input-wrap" }, keyInput, keyVisibility);
  const capabilityHint = h("div", { class: "th-field-hint" });
  const multimodalControl = switchControl(provider.supportsMultimodal, `Multimodal for ${provider.name}`, (enabled) => {
    setBusy(true);
    draftState.textContent = "Updating image support…";
    void controller.setMultimodal(provider.id, enabled).catch((reason) => {
      multimodalInput.checked = provider.supportsMultimodal;
      setBusy(false);
      reportFailure(reason);
    });
  });
  const multimodalInput = multimodalControl.querySelector("input")!;
  const imageInputSelect = h("select", {
    class: "th-input th-mode-select",
    "aria-label": "Image input mode",
  }) as HTMLSelectElement;
  const imageInputHint = h("div", { class: "th-field-hint" });
  const syncImageInputHint = () => {
    imageInputHint.textContent = !provider.supportsMultimodal
      ? "Enable image support to choose an input method."
      : imageInputSelect.value === "file"
        ? "Send images through the Moonshot file upload channel."
        : imageInputSelect.value === "url"
          ? "Send images using URLs from Cloud Storage."
          : "Send images inline with each request.";
  };
  const refreshImageInputOptions = (
    desired?: "url" | "base64" | "file",
  ): void => {
    const kimi = isMoonshotProviderBaseUrl(urlInput.value);
    const choices: Array<{ value: "url" | "base64" | "file"; label: string }> = kimi
      ? [
          { value: "base64", label: "Base64" },
          { value: "file", label: "Moonshot file upload (ms://)" },
        ]
      : [
          { value: "url", label: "Image URL (via Cloud Storage)" },
          { value: "base64", label: "Base64" },
        ];
    const current = desired ?? imageInputSelect.value as "url" | "base64" | "file";
    const next = choices.some((choice) => choice.value === current)
      ? current
      : choices[0]!.value;
    imageInputSelect.replaceChildren(...choices.map((choice) =>
      h("option", { value: choice.value }, choice.label)));
    imageInputSelect.value = next;
    syncImageInputHint();
  };
  refreshImageInputOptions(provider.imageInput);
  imageInputSelect.disabled = !provider.supportsMultimodal;

  // ── API protocol + hosted tools (Responses) ─────────────────
  const providerTools = normalizeToolsArray(provider.responsesTools);
  const protocolSelect = h("select", {
    class: "th-input th-mode-select",
    "aria-label": "API protocol",
  }) as HTMLSelectElement;
  protocolSelect.replaceChildren(
    h("option", { value: "auto" }, "Auto (from URL)"),
    h("option", { value: "chat_completions" }, "Chat Completions"),
    h("option", { value: "responses" }, "Responses"),
  );
  protocolSelect.value = provider.apiProtocol ?? "auto";
  const protocolHint = h("div", { class: "th-field-hint" });
  const responsesBlock = h("section", {
    class: "th-detail-section th-detail-capabilities th-detail-responses",
    "aria-label": "Responses options",
  });
  const syncProtocolState = () => {
    const responses = protocolSelect.value === "responses"
      || (protocolSelect.value === "auto" && /\/responses([/?#]|$)/.test(urlInput.value.trim()));
    protocolHint.textContent = responses ? "Requests use the Responses API." : "Requests use Chat Completions.";
    responsesBlock.hidden = !responses;
    // Mirror the desktop: an unset keep-state follows the provider profile,
    // so a Base URL edit re-resolves the switch display (never persisted
    // until the user toggles it explicitly).
    if (provider.responsesStateful === undefined) {
      statefulInput.checked = resolveResponsesStateful({ baseUrl: urlInput.value.trim() });
    }
  };
  protocolSelect.addEventListener("change", () => {
    syncProtocolState();
    const value = protocolSelect.value;
    patchApi(
      { apiProtocol: value === "chat_completions" || value === "responses" ? value : "auto" },
      "Updating API protocol…",
    );
  });
  urlInput.addEventListener("input", syncProtocolState);

  const patchApi = (patch: Record<string, unknown>, note: string) => {
    setBusy(true);
    draftState.textContent = note;
    void controller.updateProvider(provider.id, patch).catch((reason) => {
      setBusy(false);
      reportFailure(reason);
    });
  };
  const rawEndpointControl = switchControl(provider.rawEndpoint === true, `Full endpoint URL for ${provider.name}`, (enabled) => {
    patchApi({ rawEndpoint: enabled }, "Updating endpoint mode…");
  });
  const rawEndpointInput = rawEndpointControl.querySelector("input")!;
  const statefulControl = switchControl(resolveResponsesStateful(provider), `Keep Responses conversation state for ${provider.name}`, (enabled) => {
    patchApi({ responsesStateful: enabled }, "Updating conversation state…");
  });
  const statefulInput = statefulControl.querySelector("input")!;
  // Two-turn state probe: positive verdicts can be applied; a definitive
  // stateless verdict immediately persists the safe default. The relay probes
  // with the stored key; this UI never sees it.
  const probeNote = h("span", { class: "th-probe-row", hidden: true, role: "status", "aria-live": "polite" });
  const probeBtn = h("button", { class: "th-probe-btn", type: "button" }, "Test state support");
  const runProbe = () => {
    probeBtn.disabled = true;
    probeBtn.textContent = "Testing…";
    probeNote.hidden = true;
    void controller.probeProviderState(provider.id)
      .then((result) => {
        probeNote.hidden = false;
        const children: Node[] = [
          statusChip(result.ok ? (result.supported ? "Stateful" : "Stateless") : "Unknown",
            result.ok ? (result.supported ? "ok" : "warn") : "muted"),
        ];
        if (result.ok && result.supported) {
          const apply = h("button", { class: "th-probe-btn", type: "button" }, "Apply");
          apply.addEventListener("click", () => {
            patchApi({ responsesStateful: true }, "Applying probe result…");
          });
          children.push(apply);
        } else if (!result.ok) {
          children.push(h("span", { class: "th-field-hint" }, result.reason));
        }
        probeNote.replaceChildren(...children);
        if (result.ok && !result.supported) {
          patchApi({ responsesStateful: false }, "Applying probe result…");
        }
        probeBtn.textContent = result.ok ? "Test again" : "Retry";
      })
      .catch((reason) => {
        probeNote.hidden = false;
        probeNote.replaceChildren(
          statusChip("Unknown", "muted"),
          h("span", { class: "th-field-hint" }, reason instanceof Error ? reason.message : String(reason)),
        );
        probeBtn.textContent = "Retry";
      })
      .finally(() => {
        // syncSave recomputes the dirty-driven disabled state for this button.
        syncSave();
      });
  };
  probeBtn.addEventListener("click", runProbe);
  const toolInputs: HTMLInputElement[] = [];
  const toolControls: HTMLElement[] = [];
  for (const spec of HOSTED_TOOL_FAMILIES) {
    const control = switchControl(toolEnabled(providerTools, spec.family), `${spec.label} for ${provider.name}`, (enabled) => {
      patchApi(
        { responsesTools: setToolEnabled(normalizeToolsArray(provider.responsesTools), spec.family, enabled) },
        "Updating hosted tools…",
      );
    });
    toolInputs.push(control.querySelector("input")!);
    toolControls.push(control);
  }
  const toolsInput = h("textarea", {
    class: "th-input th-json-input",
    rows: "4",
    spellcheck: "false",
    "aria-label": "Hosted tools JSON",
    placeholder: '[{"type":"web_search"}]',
  }) as HTMLTextAreaElement;
  toolsInput.value = JSON.stringify(providerTools, null, 2);
  // Immediate-commit controls lock while the draft is dirty (multimodal
  // parity). toolsInput is a DRAFT field — it must never disable itself on
  // its own edits, so it rides `fields`-style busy handling instead.
  const apiBusyControls: Array<HTMLInputElement | HTMLSelectElement | HTMLButtonElement> = [
    protocolSelect, rawEndpointInput, statefulInput, probeBtn, ...toolInputs,
  ];

  const fields = [nameInput, modelInput, urlInput, keyInput];
  const save = h("button", { class: "ghost-btn th-detail-save action-primary", type: "button" }, "Save changes");
  const cancel = h("button", { class: "ghost-btn th-detail-cancel", type: "button", hidden: true }, "Cancel");
  const draftState = h("span", { class: "th-detail-save-state", role: "status", "aria-live": "polite" });
  const syncSave = () => {
    const name = nameInput.value.trim();
    const modelId = modelInput.value.trim();
    const baseUrl = normalizeProviderBaseUrl(urlInput.value, provider.rawEndpoint === true);
    const key = keyInput.value.trim();
    const imageInput = imageInputSelect.value;
    const toolsParsed = parseHostedToolsJson(toolsInput.value);
    const toolsChanged = toolsParsed.ok
      && JSON.stringify(toolsParsed.tools) !== JSON.stringify(providerTools);
    const dirty = !toolsParsed.ok
      || name !== provider.name
      || modelId !== provider.modelId
      || baseUrl !== normalizeProviderBaseUrl(provider.baseUrl, provider.rawEndpoint === true)
      || key.length > 0
      || imageInput !== provider.imageInput
      || toolsChanged;
    save.disabled = !name || !modelId || !baseUrl || !dirty || !toolsParsed.ok;
    cancel.hidden = !dirty;
    draftState.textContent = !toolsParsed.ok
      ? toolsParsed.error
      : dirty ? "Unsaved changes" : "No changes";
    // These switches commit immediately and the controller redraws Manage.
    // Keep draft fields intact until the user explicitly saves or cancels.
    multimodalInput.disabled = dirty;
    for (const control of apiBusyControls) control.disabled = dirty;
    capabilityHint.textContent = dirty
      ? "Save or cancel changes before updating image support."
      : `${source} · ${provider.supportsMultimodal ? "accepts image input" : "text only"}`;
  };
  const resetDraft = () => {
    nameInput.value = provider.name;
    modelInput.value = provider.modelId;
    urlInput.value = provider.baseUrl;
    keyInput.value = "";
    keyInput.type = "password";
    keyVisibility.innerHTML = icon("eye", 14);
    keyVisibility.setAttribute("aria-label", "Show new API key");
    toolsInput.value = JSON.stringify(providerTools, null, 2);
    refreshImageInputOptions(provider.imageInput);
    syncSave();
  };
  const setBusy = (busy: boolean) => {
    if (!busy) save.removeAttribute("aria-busy");
    for (const field of fields) field.disabled = busy;
    toolsInput.disabled = busy;
    imageInputSelect.disabled = busy || !provider.supportsMultimodal;
    cancel.disabled = busy;
    keyVisibility.disabled = busy;
    multimodalInput.disabled = busy;
    for (const control of apiBusyControls) control.disabled = busy;
    if (busy) save.disabled = true;
    else syncSave();
  };
  const commit = () => {
    if (save.disabled) return;
    const name = nameInput.value.trim();
    const modelId = modelInput.value.trim();
    const baseUrl = normalizeProviderBaseUrl(urlInput.value, provider.rawEndpoint === true);
    const key = keyInput.value.trim();
    const imageInput = imageInputSelect.value as "url" | "base64" | "file";
    const toolsParsed = parseHostedToolsJson(toolsInput.value);
    if (!name || !modelId || !baseUrl) {
      reportFailure(new Error("Name, model ID, and base URL are required."));
      return;
    }
    if (!toolsParsed.ok) {
      reportFailure(new Error(toolsParsed.error));
      return;
    }
    const patch: {
      name?: string;
      modelId?: string;
      baseUrl?: string;
      apiKey?: string;
      imageInput?: "url" | "base64" | "file";
      responsesTools?: Array<Record<string, unknown>>;
    } = {};
    if (name !== provider.name) patch.name = name;
    if (modelId !== provider.modelId) patch.modelId = modelId;
    if (baseUrl !== normalizeProviderBaseUrl(provider.baseUrl, provider.rawEndpoint === true)) patch.baseUrl = baseUrl;
    if (key) patch.apiKey = key;
    if (imageInput !== provider.imageInput) patch.imageInput = imageInput;
    if (JSON.stringify(toolsParsed.tools) !== JSON.stringify(providerTools)) patch.responsesTools = toolsParsed.tools;
    if (!patch.name && !patch.modelId && !patch.baseUrl && !patch.apiKey && !patch.imageInput && !patch.responsesTools) {
      syncSave();
      return;
    }
    setBusy(true);
    save.setAttribute("aria-busy", "true");
    draftState.textContent = "Saving…";
    void controller.updateProvider(provider.id, patch).catch((reason) => {
      setBusy(false);
      resetDraft();
      reportFailure(reason);
    });
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    } else if (event.key === "Escape") {
      resetDraft();
    }
  };
  for (const field of fields) {
    field.addEventListener("input", syncSave);
    field.addEventListener("keydown", onKey);
  }
  toolsInput.addEventListener("input", syncSave);
  urlInput.addEventListener("input", () => {
    refreshImageInputOptions();
    syncSave();
  });
  imageInputSelect.addEventListener("change", () => {
    syncImageInputHint();
    syncSave();
  });
  cancel.addEventListener("click", resetDraft);
  save.addEventListener("click", commit);

  responsesBlock.append(
    h("h3", { class: "th-detail-section-title" }, "Responses options"),
    h("div", { class: "th-detail-options" },
      h("div", { class: "th-detail-capability-row" },
        h("div", {},
          h("div", { class: "th-field-label" }, "Keep Responses conversation state"),
          h("div", { class: "th-field-hint" }, "Reuse server-side conversation state (store + previous_response_id). Turn off for stateless gateways."),
          h("div", { class: "th-probe-row" }, probeBtn, probeNote)),
        statefulControl),
      ...HOSTED_TOOL_FAMILIES.map((spec, index) =>
        h("div", { class: "th-detail-capability-row" },
          h("div", {},
            h("div", { class: "th-field-label" }, spec.label),
            h("div", { class: "th-field-hint" }, `Offer the hosted ${spec.label.toLowerCase()} tool from the provider's Responses API.`)),
          toolControls[index]!),
      )),
    h("label", { class: "th-detail-field th-detail-tools-field" },
      h("span", { class: "th-detail-label" }, "Hosted tools (JSON)"),
      toolsInput,
      h("span", { class: "th-field-hint" }, "Configure file search, MCP, or options for the tools above. Existing options are preserved when enabling another tool.")),
  );
  syncSave();
  syncProtocolState();
  return h("div", { class: "th-detail" },
    h("div", { class: "th-detail-main" },
      h("section", { class: "th-detail-section", "aria-label": "Connection" },
        h("h3", { class: "th-detail-section-title" }, "Connection"),
        h("div", { class: "th-detail-fields" },
          detailField("Name", nameInput),
          detailField("Model ID", modelInput),
          detailField("Base URL", urlInput, true),
          detailField("API key", keyWrap, true,
            h("span", { class: "th-detail-key-state" },
              icon("lock", 11), provider.apiKeyConfigured ? "Configured" : "Not set")))),
      h("section", { class: "th-detail-section", "aria-label": "API settings" },
        h("h3", { class: "th-detail-section-title" }, "API settings"),
        h("label", { class: "th-detail-field" },
          h("span", { class: "th-detail-label" }, "Protocol"),
          h("span", { class: "th-mode-select-wrap" }, protocolSelect,
            h("span", { class: "th-mode-select-icon", "aria-hidden": "true" }, icon("chevronDown", 14))),
          protocolHint),
        h("div", { class: "th-detail-capability-row" },
          h("div", {},
            h("div", { class: "th-field-label" }, "Full endpoint URL"),
            h("div", { class: "th-field-hint" }, "Use the Base URL exactly as-is. The API protocol still controls the request format.")),
          rawEndpointControl)),
      h("section", {
        class: "th-detail-section th-detail-capabilities",
        "aria-label": "Image input",
      },
        h("h3", { class: "th-detail-section-title" }, "Image input"),
        h("div", { class: "th-detail-capability-row" },
          h("div", {},
            h("div", { class: "th-field-label" }, "Image support"),
            capabilityHint),
          multimodalControl),
        h("label", { class: `th-detail-field th-detail-image-field${provider.supportsMultimodal ? "" : " is-disabled"}` },
          h("span", { class: "th-detail-label" }, "Input method"),
          h("span", { class: "th-mode-select-wrap" }, imageInputSelect,
            h("span", { class: "th-mode-select-icon", "aria-hidden": "true" }, icon("chevronDown", 14))),
          imageInputHint)),
      responsesBlock),
    h("div", { class: "th-detail-actions" },
      h("button", {
        class: "ghost-btn th-detail-delete action-danger",
        type: "button",
        onclick: () => {
          if (confirm(`Delete “${provider.name}” and remove it from every device?`)) {
            void controller.removeProvider(provider.id).catch(reportFailure);
          }
        },
      }, icon("trash2", 13), "Delete"),
      draftState,
      cancel,
      save),
  );
}

export function renderTokenHubView(controller: TokenHubController): HTMLElement {
  const snapshot = controller.getSnapshot();
  if (snapshot.status !== "ready") {
    const text = snapshot.status === "loading"
      ? "Loading encrypted providers…"
      : (snapshot.statusDetail ?? "Encrypted storage is unavailable.");
    return h("div", { class: "token-hub-body is-status" }, h("div", { class: "th-empty-row" }, text));
  }
  const selected = snapshot.providers.find((provider) => provider.id === snapshot.selectedProviderId)
    ?? snapshot.providers[0]
    ?? null;
  if (!snapshot.providers.length) {
    return h("div", { class: "token-hub-body is-status" },
      h("div", { class: "th-empty-row" }, "No providers yet. Add one to detect models and assign them to devices."));
  }
  const orderStatus = h("div", { class: "th-order-status", role: "status", "aria-live": "polite" });
  const body = h("div", { class: "token-hub-body" },
    h("aside", { class: "th-rail" }, providerList(snapshot, controller, orderStatus), orderStatus),
    selected
      ? providerDetail(selected, controller)
      : h("div", { class: "th-detail th-empty-detail" },
          h("div", { class: "th-empty-row" }, "Select a provider.")),
  );
  return body;
}

function syncProviderIcon(provider: { name: string; baseUrl: string; modelId: string }): HTMLElement {
  const brand = matchModelBrand(provider);
  if (!brand) return h("span", { class: "th-model-mark" }, provider.name.slice(0, 1).toUpperCase());
  const brandIcon = createBrandIcon(brand, 14);
  brandIcon.classList.add("th-provider-brand");
  return brandIcon;
}

function providerMeta(className: string, model: string, host: string, endpoint: string): HTMLElement {
  return h("span", { class: className, title: `${model} · ${endpoint}` },
    h("span", { class: "th-profile-model" }, model),
    h("span", { class: "th-profile-separator", "aria-hidden": "true" }, " · "),
    h("span", { class: "th-profile-host" }, host));
}

function syncProviderCopy(provider: { name: string; baseUrl: string; modelId: string }): HTMLElement {
  let host = provider.baseUrl;
  try { host = new URL(provider.baseUrl).hostname; } catch { /* Show the original endpoint. */ }
  return h("span", { class: "th-profile-copy" },
    h("span", { class: "th-profile-name", title: provider.name }, provider.name),
    providerMeta("th-profile-meta", provider.modelId, host, provider.baseUrl));
}

/** Device dialogs stay mounted while the main Devices pane re-renders. */
function deviceDialog(title: string, subtitle: string): {
  dialog: HTMLElement; body: HTMLElement; footer: HTMLElement; close: () => void; onClose: (fn: () => void) => void;
} {
  const previousFocus = document.activeElement as HTMLElement | null;
  const overlay = h("div", { class: "th-overlay th-device-overlay" });
  const dialog = h("div", { class: "th-dialog th-device-dialog", role: "dialog", "aria-modal": "true", "aria-label": title });
  const body = h("div", { class: "th-device-dialog-body" });
  const footer = h("div", { class: "th-device-dialog-footer" });
  let cleanup = () => {};
  const close = () => {
    cleanup();
    overlay.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
    else document.querySelector<HTMLButtonElement>(".th-device-add")?.focus();
  };
  const closeButton = h("button", { class: "th-icon-btn", type: "button", "aria-label": "Close", onclick: close }, icon("x", 14));
  dialog.append(h("div", { class: "th-dialog-head" },
    h("div", {}, h("h2", { class: "th-dialog-title" }, title), h("div", { class: "th-dialog-sub" }, subtitle)),
    closeButton), body, footer);
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key !== "Tab") return;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.body.append(overlay);
  closeButton.focus();
  return { dialog, body, footer, close, onClose: (fn) => { cleanup = fn; } };
}

function confirmDeviceProvider(opts: {
  title: string; providerName: string; message: string; action: string; danger?: boolean; onConfirm: () => Promise<unknown>;
}): void {
  const modal = deviceDialog(opts.title, opts.providerName);
  modal.dialog.classList.add("th-device-confirm");
  modal.body.append(h("p", { class: "th-device-confirm-copy" }, opts.message));
  const cancel = h("button", { class: "ghost-btn", type: "button", onclick: modal.close }, "Cancel");
  const submit = h("button", {
    class: `ghost-btn th-device-confirm-submit ${opts.danger ? "is-danger action-danger" : "action-primary"}`,
    type: "button",
    onclick: () => { modal.close(); void opts.onConfirm().catch(() => {}); },
  }, opts.action);
  modal.footer.append(cancel, submit);
  cancel.focus();
}

function openDeviceHubDialog(deviceId: string, deviceName: string, controller: TokenHubController): void {
  const modal = deviceDialog("Add from Hub", `To ${deviceName}`);
  const done = h("button", { class: "ghost-btn", type: "button", onclick: modal.close }, "Done");
  modal.footer.append(done);
  const render = () => {
    const activeId = (document.activeElement as HTMLElement | null)?.dataset.hubProviderId;
    const preview = controller.getDeviceSyncPreview(deviceId);
    const pending = controller.getSyncPending(deviceId);
    const error = controller.getSyncError(deviceId);
    const busy = pending !== null;
    modal.body.replaceChildren();
    if (!preview || pending === "preview") {
      modal.body.append(h("div", { class: "th-empty-row", role: "status" }, pending === "preview" ? "Loading Hub providers…" : error ?? "Loading providers…"));
      if (error && !busy) modal.body.append(h("button", {
        class: "th-link-btn th-device-retry", type: "button",
        onclick: () => { void controller.loadDeviceSyncPreview(deviceId).catch(() => {}); },
      }, "Retry"));
      return;
    }
    if (error) modal.body.append(h("div", { class: "th-inline-error", role: "alert" }, icon("warn", 13), h("span", {}, error)));
    if (!preview.deviceOnline || !preview.supportsSync) {
      modal.body.append(h("div", { class: "th-empty-row" }, preview.deviceOnline
        ? "Update this device to manage providers remotely."
        : "Device offline — adding providers is unavailable."));
      return;
    }
    const rows = h("ul", { class: "th-device-hub-list", "aria-label": "Hub LLM Providers" });
    for (const provider of preview.hubProviders) {
      const operation = controller.getDeviceOperation(deviceId, "push", provider.id);
      const replacing = provider.match === "overwrite";
      const label = operation?.status === "pending" ? (replacing ? "Replacing…" : "Adding…")
        : operation?.status === "done" ? (operation.action === "overwrite" ? "Replaced" : "Added")
        : operation?.status === "failed" ? "Failed · Retry" : replacing ? "Replace" : "Add";
      const action = h("button", {
        class: `th-device-hub-action action-primary${operation?.status === "done" ? " is-done" : operation?.status === "failed" ? " is-error" : ""}`,
        type: "button", "data-hub-provider-id": provider.id, "aria-label": `${label}: ${provider.name}`,
        disabled: busy || operation?.status === "done",
        "aria-busy": String(operation?.status === "pending"),
        onclick: () => { void controller.pushProviderToDevice(deviceId, provider.id).catch(() => {}); },
      }, operation?.status === "pending" ? h("span", { class: "spinner th-button-spinner", "aria-hidden": "true" })
        : operation?.status === "done" ? icon("check", 13) : operation?.status === "failed" ? icon("refresh", 13) : null,
      label);
      rows.append(h("li", { class: "th-device-hub-row" }, syncProviderIcon(provider), syncProviderCopy(provider), action));
    }
    if (!preview.hubProviders.length) rows.append(h("li", { class: "th-empty-row" }, "No providers in the Hub yet."));
    modal.body.append(rows);
    if (activeId) {
      const button = [...rows.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.dataset.hubProviderId === activeId);
      if (button && !button.disabled) button.focus(); else done.focus();
    }
  };
  modal.onClose(controller.subscribe(render));
  render();
  void controller.loadDeviceSyncPreview(deviceId).catch(() => {});
}

export function buildDeviceProviderCard(
  deviceId: string, deviceName: string, online: boolean, controller: TokenHubController,
): HTMLElement {
  const snapshot = controller.getSnapshot();
  const preview = controller.getDeviceSyncPreview(deviceId);
  const pending = controller.getSyncPending(deviceId);
  const error = controller.getSyncError(deviceId);
  const providers = preview?.deviceProviders ?? [];
  const busy = pending !== null;
  const available = online && preview?.deviceOnline && preview.supportsSync && snapshot.status === "ready";
  const status = !online ? (providers.length ? "Offline · showing last loaded providers" : "Device offline")
    : pending === "preview" ? "Loading device providers…"
    : !preview ? (error ? "Could not load device providers" : "Loading device providers…")
    : !preview.supportsSync ? "Update this device to manage providers remotely."
    : `${providers.length} provider${providers.length === 1 ? "" : "s"} on this device`;
  const rows = h("ul", { class: "th-device-profiles", "aria-label": `Providers on ${deviceName}` });
  for (const provider of providers) {
    const copying = controller.getDeviceOperation(deviceId, "pull", provider.id);
    const removing = controller.getDeviceOperation(deviceId, "remove", provider.id);
    const label = copying?.status === "pending" ? "Copying…" : copying?.status === "done" ? "Copied"
      : copying?.status === "failed" ? "Failed · Retry" : "Copy to Relay";
    const copyButton = h("button", {
      class: `ghost-btn th-device-copy${copying?.status === "done" ? " is-done" : copying?.status === "failed" ? " is-error" : ""}`,
      type: "button", "data-provider-action": "copy", "aria-label": `${label}: ${provider.name}`,
      disabled: !available || busy || copying?.status === "done",
      "aria-busy": String(copying?.status === "pending"),
      onclick: () => {
        if (provider.match === "overwrite") confirmDeviceProvider({
          title: "Replace provider in Relay?", providerName: provider.name, action: "Replace",
          message: `A provider with this endpoint and model already exists in the Hub. Replace it with the copy from ${deviceName}?`,
          onConfirm: () => controller.pullProviderFromDevice(deviceId, provider.id),
        });
        else void controller.pullProviderFromDevice(deviceId, provider.id).catch(() => {});
      },
    }, copying?.status === "pending" ? h("span", { class: "spinner th-button-spinner", "aria-hidden": "true" })
      : icon(copying?.status === "done" ? "check" : copying?.status === "failed" ? "refresh" : "copy", 13), label);
    const removeButton = h("button", {
      class: "th-icon-btn th-device-delete action-danger action-danger-list", type: "button", "data-provider-action": "delete",
      "aria-busy": String(removing?.status === "pending"),
      "aria-label": `Delete ${provider.name} from ${deviceName}`,
      title: providers.length === 1 ? "The last provider cannot be deleted." : removing?.error ?? "Delete from this device",
      disabled: !available || busy || providers.length === 1,
      onclick: () => confirmDeviceProvider({
        title: "Delete provider?", providerName: provider.name, action: "Delete", danger: true,
        message: `Remove this provider from ${deviceName}?`,
        onConfirm: () => controller.removeProviderFromDevice(deviceId, provider.id),
      }),
    }, removing?.status === "pending" ? h("span", { class: "spinner th-button-spinner", "aria-hidden": "true" })
      : icon(removing?.status === "failed" ? "refresh" : "trash2", 13));
    rows.append(h("li", { class: "th-device-profile-row", "data-provider-id": provider.id },
      syncProviderIcon(provider), syncProviderCopy(provider),
      h("div", { class: "th-device-row-actions" }, copyButton, removeButton)));
  }
  if (!providers.length) rows.append(h("li", { class: "th-empty-row" },
    !online ? "Connect this device to load its providers."
      : preview?.supportsSync ? "This device has no LLM providers." : status));
  const body = h("div", { class: "card-body flush" }, rows,
    h("span", { class: "th-device-live", role: "status", "aria-live": "polite", "aria-atomic": "true" }, controller.getSyncAnnouncement(deviceId)));
  if (providers.length === 1) body.append(h("div", { class: "th-device-list-note" }, "At least one provider is required on this device."));
  if (error || snapshot.status === "unavailable") {
    body.append(h("div", { class: "th-inline-error th-device-sync-error", role: "alert" }, icon("warn", 13),
      h("span", {}, error ?? snapshot.statusDetail ?? "Encrypted storage is unavailable."),
      ...(online && !busy ? [h("button", { class: "th-link-btn", type: "button", onclick: () => {
        void controller.loadDeviceSyncPreview(deviceId).catch(() => {});
      } }, "Retry")] : [])));
  }
  return h("div", { class: "card th-device-card", "data-device-id": deviceId },
    h("div", { class: "card-head" },
      h("span", { class: "ic card-header-symbol" }, cardHeaderIcon("providers")),
      h("div", { class: "th-device-heading" }, h("div", { class: "t" }, "LLM Providers"), h("div", { class: "d", role: "status" }, status)),
      h("div", { class: "card-actions" }, h("button", {
        class: "ghost-btn th-device-add action-primary", type: "button", disabled: !available || busy,
        onclick: () => openDeviceHubDialog(deviceId, deviceName, controller),
      }, icon("plus", 13), "Add from Hub"))), body);
}
