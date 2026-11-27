import type { ComputerLoginIdentity } from "../../../../shared/computerLogins.js";
import "../../ui/edit-workspace-dialog.css";

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text = ""): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function button(label: string, style = ""): HTMLButtonElement {
  const control = element("button", `setting-btn ${style}`.trim(), label);
  control.type = "button";
  return control;
}

export class ComputerLoginSettings {
  readonly root = element("div", "setting-mode-rows");
  readonly addButton = button("Add login", "setting-btn-primary");
  private dialog: HTMLDialogElement | null = null;
  private disposed = false;
  private refreshId = 0;

  constructor() {
    this.addButton.disabled = true;
    this.addButton.addEventListener("click", () => this.editLogin());
  }

  async refresh(): Promise<void> {
    const refreshId = ++this.refreshId;
    const bridge = window.jellybot;
    try {
      const result = await bridge?.listComputerLogins?.();
      if (this.disposed || refreshId !== this.refreshId) return;
      this.addButton.disabled = !result?.available;
      if (!result?.available) {
        this.showStatus("System credential storage is unavailable.");
      } else if (!result.entries.length) {
        this.showStatus("No saved logins");
      } else {
        this.root.replaceChildren(...result.entries.map(entry => this.loginRow(entry)));
      }
    } catch {
      if (this.disposed || refreshId !== this.refreshId) return;
      this.addButton.disabled = true;
      this.showStatus("Could not load saved logins.");
    }
  }

  destroy(): void {
    this.disposed = true;
    this.dialog?.close();
  }

  private showStatus(message: string): void {
    const status = element("span", "setting-field-hint", message);
    status.setAttribute("role", "status");
    this.root.replaceChildren(status);
  }

  private loginRow(entry: ComputerLoginIdentity): HTMLElement {
    const row = element("div", "setting-toggle-row setting-computer-login");
    const identity = element("div", "setting-toggle-copy");
    identity.append(
      element("span", "setting-field-label", new URL(entry.origin).host),
      element("span", "setting-field-hint", entry.account),
    );
    const actions = element("div", "setting-card-actions");
    const edit = button("Edit");
    const remove = button("Remove");
    edit.setAttribute("aria-label", `Edit login for ${entry.account} at ${entry.origin}`);
    remove.setAttribute("aria-label", `Remove login for ${entry.account} at ${entry.origin}`);
    edit.addEventListener("click", () => this.editLogin(entry));
    remove.addEventListener("click", () => this.removeLogin(entry));
    actions.append(edit, remove);
    row.append(identity, actions);
    return row;
  }

  private openDialog(title: string, label: string, action: (dialog: HTMLDialogElement) => Promise<boolean>, entry?: ComputerLoginIdentity, danger = false): void {
    if (this.dialog) return;
    const dialog = element("dialog", "edit-workspace-dialog setting-login-dialog");
    this.dialog = dialog;
    const heading = element("h2", "edit-workspace-title", title);
    heading.id = "setting-login-dialog-title";
    dialog.setAttribute("aria-labelledby", heading.id);
    const form = element("form", "setting-login-form");
    form.method = "dialog";
    form.autocomplete = "off";
    const error = element("p", "setting-card-status is-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const actions = element("div", "setting-card-actions");
    const submit = button(label, danger ? "action-danger" : "setting-btn-primary");
    submit.type = "submit";
    const cancel = button("Cancel");
    cancel.addEventListener("click", () => dialog.close());
    actions.append(cancel, submit);
    form.append(error, actions);
    dialog.append(heading);
    if (entry && danger) dialog.append(element("p", "setting-field-hint", `${entry.account} · ${new URL(entry.origin).host}`));
    dialog.append(form);
    let pending = false;
    dialog.addEventListener("cancel", event => { if (pending) event.preventDefault(); });
    dialog.addEventListener("close", () => {
      const password = form.querySelector<HTMLInputElement>('input[type="password"]');
      if (password) password.value = "";
      this.dialog = null;
      dialog.remove();
    }, { once: true });
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (pending) return;
      pending = submit.disabled = cancel.disabled = true;
      error.hidden = true;
      try {
        if (!await action(dialog)) throw new Error(danger ? "Could not remove this login." : "Could not save this login. Check whether it already exists.");
        if (this.disposed) return;
        dialog.close();
        await this.refresh();
        if (!this.disposed) this.addButton.focus();
      } catch (failure) {
        error.textContent = failure instanceof Error ? failure.message : "The operation failed.";
        error.hidden = false;
      } finally {
        pending = submit.disabled = cancel.disabled = false;
      }
    });
    document.body.append(dialog);
    this.appendFieldsAndShow(dialog, form, cancel, entry, danger);
  }

  private appendFieldsAndShow(dialog: HTMLDialogElement, form: HTMLFormElement, cancel: HTMLButtonElement, entry: ComputerLoginIdentity | undefined, danger: boolean): void {
    if (!danger) {
      const field = (label: string, name: string, type: string, maxLength: number, value = ""): HTMLLabelElement => {
        const wrapper = element("label", "setting-field");
        const input = element("input", "setting-input");
        input.name = name;
        input.type = type;
        input.required = true;
        input.maxLength = maxLength;
        input.value = value;
        input.spellcheck = false;
        input.autocomplete = type === "password" ? "new-password" : "off";
        if (type === "url") input.placeholder = "https://";
        wrapper.append(element("span", "setting-field-label", label), input);
        return wrapper;
      };
      form.prepend(
        field("Website", "website", "url", 2048, entry?.origin),
        field("Account", "account", "text", 512, entry?.account),
        field("Password", "password", "password", 4096),
      );
    }
    dialog.showModal();
    if (danger) cancel.focus();
  }

  private editLogin(entry?: ComputerLoginIdentity): void {
    this.openDialog(entry ? "Edit login" : "Add login", "Save", async dialog => {
      const origin = dialog.querySelector<HTMLInputElement>('[name="website"]')!.value.trim();
      const account = dialog.querySelector<HTMLInputElement>('[name="account"]')!.value;
      const password = dialog.querySelector<HTMLInputElement>('[name="password"]')!;
      const url = URL.parse(origin);
      if (!url || url.protocol !== "https:" || url.username || url.password) throw new Error("Enter an HTTPS website.");
      if (!account.trim()) throw new Error("Enter an account name.");
      const secret = password.value;
      password.value = "";
      return await window.jellybot!.saveComputerLogin(url.origin, account, secret, entry);
    }, entry);
  }

  private removeLogin(entry: ComputerLoginIdentity): void {
    this.openDialog("Remove login?", "Remove", () => window.jellybot!.removeComputerLogin(entry.origin, entry.account), entry, true);
  }
}
