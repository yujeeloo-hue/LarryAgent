import { KeyRound, Plus, Trash2 } from "lucide";
import { createLucideIcon } from "../../ui/icons.js";

export type JevModelForm = {
  name: string;
  baseUrl: string;
  modelId: string;
};

export type JevModelViewState = {
  profile: JevModelForm | null;
  keyConfigured: boolean;
  busy: boolean;
};

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text = ""): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function button(className: string, label: string): HTMLButtonElement {
  const control = element("button", className, label);
  control.type = "button";
  return control;
}

function input(name: string, placeholder: string, type = "text"): HTMLInputElement {
  const control = element("input", "setting-input");
  control.name = name;
  control.type = type;
  control.placeholder = placeholder;
  control.spellcheck = false;
  control.autocomplete = "off";
  return control;
}

function field(label: string, control: HTMLElement, hint?: string): HTMLLabelElement {
  const row = element("label", "setting-field");
  row.append(element("span", "setting-field-label", label), control);
  if (hint) row.append(element("span", "setting-field-hint", hint));
  return row;
}

export class JevModelSettingsView {
  readonly addButton = button("setting-btn setting-btn-icon", "");
  readonly nameInput = input("jevName", "Jev");
  readonly baseUrlInput = input("jevBaseUrl", "https://openrouter.ai/api");
  readonly modelIdInput = input("jevModelId", "typesafe/jev-1.14");
  readonly apiKeyInput = input("jevApiKey", "Paste API key — saved when you leave the field", "password");
  readonly testButton = button("setting-btn action-primary", "Test");
  readonly deleteButton = button("setting-btn action-danger", "");
  readonly clearKeyButton = button("setting-btn action-danger", "Clear key");

  private readonly listEl = element("div", "setting-provider-list");
  private readonly detailEl = element("div", "setting-provider-detail");
  private readonly keyBlock = element("div", "setting-api-key-block");
  private readonly keyStatus = element("div", "setting-api-key-status");
  private readonly actions = element("div", "setting-card-actions");

  constructor(private readonly parts: { body: HTMLElement; footer: HTMLElement; status: HTMLElement }) {
    this.addButton.setAttribute("aria-label", "Add decision model");
    this.addButton.title = "Add decision model";
    this.addButton.append(createLucideIcon(Plus, { size: 14 }));
    this.deleteButton.append(createLucideIcon(Trash2, { size: 14 }), document.createTextNode(" Delete"));
    this.testButton.title = "Send one small decision request to check the model and key";

    const listHeader = element("div", "setting-provider-list-header");
    listHeader.append(element("span", "setting-field-label", "Model"), this.addButton);
    this.listEl.setAttribute("role", "listbox");

    const nameModelRow = element("div", "setting-field-row setting-field-row-2");
    nameModelRow.append(field("Name", this.nameInput), field("Model ID", this.modelIdInput));
    this.detailEl.append(
      nameModelRow,
      field("Base URL", this.baseUrlInput, "Any System One endpoint (OpenRouter or TypeSafe); /v1/systemone is added automatically."),
    );
    this.keyBlock.append(
      field("API key", this.apiKeyInput, "Stored encrypted on this device — never written to settings.json."),
      this.keyStatus,
    );
    this.actions.append(this.testButton, this.deleteButton, this.clearKeyButton);

    parts.body.append(listHeader, this.listEl, this.detailEl, this.keyBlock);
    parts.footer.prepend(this.actions);
  }

  render(state: JevModelViewState): void {
    const { profile } = state;
    this.listEl.replaceChildren(profile ? this.profileRow(profile) : this.emptyRow());
    this.detailEl.hidden = !profile;
    this.keyBlock.hidden = !profile;
    this.actions.hidden = !profile;
    if (profile) {
      this.setValue(this.nameInput, profile.name);
      this.setValue(this.baseUrlInput, profile.baseUrl);
      this.setValue(this.modelIdInput, profile.modelId);
    }
    this.renderKeyStatus(state.keyConfigured);
    this.addButton.disabled = state.busy || !!profile;
    this.testButton.disabled = state.busy || !profile || !state.keyConfigured;
    this.deleteButton.disabled = state.busy || !profile;
    this.clearKeyButton.disabled = state.busy || !state.keyConfigured;
  }

  readForm(): JevModelForm {
    return {
      name: this.nameInput.value,
      baseUrl: this.baseUrlInput.value,
      modelId: this.modelIdInput.value,
    };
  }

  takeApiKeyDraft(): string {
    const draft = this.apiKeyInput.value.trim();
    this.apiKeyInput.value = "";
    return draft;
  }

  hasApiKeyDraft(): boolean {
    return this.apiKeyInput.value.trim().length > 0;
  }

  setStatus(message: string | null, kind: "ok" | "error" | "info" = "info"): void {
    const el = this.parts.status;
    el.hidden = !message;
    el.textContent = message ?? "";
    el.className = message ? `setting-card-status is-${kind}` : "setting-card-status";
  }

  onFieldsChange(handler: () => void): void {
    for (const control of [this.nameInput, this.baseUrlInput, this.modelIdInput]) {
      control.addEventListener("input", handler);
    }
  }

  onApiKeyCommit(handler: () => void): void {
    this.apiKeyInput.addEventListener("blur", handler);
    this.apiKeyInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        handler();
      }
    });
  }

  private setValue(control: HTMLInputElement, value: string): void {
    if (document.activeElement !== control && control.value !== value) control.value = value;
  }

  private emptyRow(): HTMLElement {
    return element(
      "div",
      "setting-provider-list-empty",
      "No decision model configured. Click + above to add one. Computer Use works as before without it.",
    );
  }

  private profileRow(profile: JevModelForm): HTMLElement {
    const row = element("div", "setting-provider-row is-selected");
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", "true");
    const badge = element("span", "setting-provider-active-badge", "Active");
    badge.title = "Speeds up OCR-based Computer Use";
    row.append(
      element("span", "setting-provider-row-title", profile.name || "Jev"),
      element("span", "setting-provider-row-meta", profile.modelId),
      badge,
    );
    return row;
  }

  private renderKeyStatus(configured: boolean): void {
    const badge = element("span", `setting-key-badge ${configured ? "is-ok" : "is-missing"}`);
    badge.append(createLucideIcon(KeyRound, { size: 14 }), document.createTextNode(configured ? "Saved securely" : "Not set"));
    this.keyStatus.replaceChildren(badge);
  }
}
