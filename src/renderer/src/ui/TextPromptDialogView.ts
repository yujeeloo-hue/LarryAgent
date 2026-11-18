import { isImeComposing } from "./ime.js";
import "./text-prompt-dialog.css";

export type TextPromptDialogOptions = {
  title: string;
  message?: string;
  defaultValue?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  password?: boolean;
  confirm?: boolean;
  confirmPlaceholder?: string;
  validate?: (value: string) => string | null;
  allowEmpty?: boolean;
};

export function showTextPromptDialog(
  options: TextPromptDialogOptions,
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "text-prompt-overlay";
    overlay.setAttribute("role", "presentation");

    const dialog = document.createElement("div");
    dialog.className = "text-prompt-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "text-prompt-title");

    const title = document.createElement("h2");
    title.id = "text-prompt-title";
    title.className = "text-prompt-title";
    title.textContent = options.title;

    const message =
      typeof options.message === "string" && options.message.trim()
        ? document.createElement("p")
        : null;
    if (message) {
      message.className = "text-prompt-message";
      message.textContent = options.message!.trim();
    }

    const input = document.createElement("input");
    input.type = options.password ? "password" : "text";
    input.className = "text-prompt-input";
    input.value = options.defaultValue ?? "";
    input.autocomplete = options.password ? "new-password" : "off";
    input.spellcheck = false;

    const confirmInput = options.confirm
      ? document.createElement("input")
      : null;
    if (confirmInput) {
      confirmInput.type = options.password ? "password" : "text";
      confirmInput.className = "text-prompt-input";
      confirmInput.placeholder =
        options.confirmPlaceholder ?? "Confirm passphrase";
      confirmInput.autocomplete = "new-password";
      confirmInput.spellcheck = false;
    }

    const error = document.createElement("p");
    error.className = "text-prompt-error";
    error.hidden = true;

    const actions = document.createElement("div");
    actions.className = "text-prompt-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "text-prompt-btn text-prompt-btn-cancel";
    cancelBtn.textContent = options.cancelLabel ?? "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "text-prompt-btn text-prompt-btn-confirm action-primary";
    confirmBtn.textContent = options.confirmLabel ?? "Create";

    actions.append(cancelBtn, confirmBtn);
    dialog.append(title);
    if (message) dialog.append(message);
    dialog.append(input);
    if (confirmInput) dialog.append(confirmInput);
    dialog.append(error, actions);
    overlay.append(dialog);

    const showError = (text: string): void => {
      error.textContent = text;
      error.hidden = false;
      input.focus();
    };

    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      window.removeEventListener("keydown", onKeyDown, true);
      resolve(value);
    };

    const submit = (): void => {
      if (options.password) {
        const value = input.value;
        if (confirmInput && value !== confirmInput.value) {
          showError("Passphrases do not match");
          return;
        }
        const problem = options.validate?.(value) ?? null;
        if (problem) {
          showError(problem);
          return;
        }
        finish(value);
        return;
      }
      const trimmed = input.value.trim();
      if (options.allowEmpty) {
        const problem = options.validate?.(trimmed) ?? null;
        if (problem) {
          showError(problem);
          return;
        }
        finish(trimmed);
        return;
      }
      const fallback = (options.defaultValue ?? "").trim();
      finish(trimmed || fallback || null);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    };

    const submitKey = (event: KeyboardEvent): void => {
      if (event.key === "Enter" && !isImeComposing(event)) {
        event.preventDefault();
        event.stopPropagation();
        submit();
      }
    };

    input.addEventListener("keydown", submitKey);
    confirmInput?.addEventListener("keydown", submitKey);

    const clearError = (): void => {
      error.hidden = true;
    };
    input.addEventListener("input", clearError);
    confirmInput?.addEventListener("input", clearError);

    cancelBtn.addEventListener("click", () => finish(null));
    confirmBtn.addEventListener("click", () => submit());
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) finish(null);
    });

    window.addEventListener("keydown", onKeyDown, true);
    document.body.append(overlay);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  });
}
