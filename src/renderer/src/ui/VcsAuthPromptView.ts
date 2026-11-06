import { isImeComposing } from "./ime.js";
import "./vcs-auth-prompt.css";

export type VcsAuthPromptPayload = {
  requestId: string;
  vcs: "git" | "svn";
  context: string;
  operation: string;
  detail?: string;
  defaultUsername?: string;
};

export type VcsAuthPromptResult = {
  requestId: string;
  credentials: { username: string; password: string } | null;
  remember: boolean;
};

/**
 * VCS credential prompt (git push / svn annotate+update+commit auth
 * failures). Styled after TextPromptDialogView; answers through the
 * caller (which forwards to the `vcs:authRespond` IPC). Never throws —
 * a dismiss resolves with credentials=null.
 */
export function showVcsAuthPrompt(
  payload: VcsAuthPromptPayload,
): Promise<VcsAuthPromptResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "text-prompt-overlay";
    overlay.setAttribute("role", "presentation");

    const dialog = document.createElement("div");
    dialog.className = "text-prompt-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "vcs-auth-title");

    const title = document.createElement("h2");
    title.id = "vcs-auth-title";
    title.className = "text-prompt-title";
    title.textContent =
      payload.vcs === "git"
        ? "Git credentials required"
        : "SVN credentials required";

    const message = document.createElement("p");
    message.className = "text-prompt-message";
    const context = payload.context.trim();
    const shown = context.length > 96 ? `${context.slice(0, 96)}…` : context;
    message.textContent = `${payload.operation} needs a sign-in${
      shown ? ` (${shown})` : ""
    }.`;

    const userLabel = document.createElement("label");
    userLabel.className = "vcs-auth-label";
    userLabel.textContent = "Username";
    const userInput = document.createElement("input");
    userInput.type = "text";
    userInput.className = "text-prompt-input";
    userInput.value = payload.defaultUsername ?? "";
    userInput.autocomplete = "off";
    userInput.spellcheck = false;
    userLabel.append(userInput);

    const passLabel = document.createElement("label");
    passLabel.className = "vcs-auth-label";
    passLabel.textContent = "Password";
    const passInput = document.createElement("input");
    passInput.type = "password";
    passInput.className = "text-prompt-input";
    passInput.autocomplete = "new-password";
    passInput.spellcheck = false;
    passLabel.append(passInput);

    const rememberLabel = document.createElement("label");
    rememberLabel.className = "vcs-auth-remember";
    const remember = document.createElement("input");
    remember.type = "checkbox";
    remember.checked = true;
    const rememberText = document.createElement("span");
    rememberText.textContent = "Remember (stored encrypted)";
    rememberLabel.append(remember, rememberText);

    const error = document.createElement("p");
    error.className = "text-prompt-error";
    if (payload.detail?.trim()) {
      const detail = payload.detail.trim();
      error.textContent = detail.length > 240 ? `${detail.slice(0, 240)}…` : detail;
      error.classList.add("vcs-auth-detail");
    } else {
      error.hidden = true;
    }

    const actions = document.createElement("div");
    actions.className = "text-prompt-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "text-prompt-btn text-prompt-btn-cancel";
    cancelBtn.textContent = "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "text-prompt-btn text-prompt-btn-confirm action-primary";
    confirmBtn.textContent = "Sign in";

    actions.append(cancelBtn, confirmBtn);
    dialog.append(
      title,
      message,
      userLabel,
      passLabel,
      rememberLabel,
      error,
      actions,
    );
    overlay.append(dialog);

    let settled = false;
    const finish = (credentials: VcsAuthPromptResult["credentials"]): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      window.removeEventListener("keydown", onKeyDown, true);
      resolve({
        requestId: payload.requestId,
        credentials,
        remember: remember.checked,
      });
    };

    const submit = (): void => {
      const username = userInput.value.trim();
      if (!username) {
        userInput.focus();
        return;
      }
      finish({ username, password: passInput.value });
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

    userInput.addEventListener("keydown", submitKey);
    passInput.addEventListener("keydown", submitKey);
    cancelBtn.addEventListener("click", () => finish(null));
    confirmBtn.addEventListener("click", () => submit());
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) finish(null);
    });

    window.addEventListener("keydown", onKeyDown, true);
    document.body.append(overlay);
    requestAnimationFrame(() => {
      if (userInput.value) {
        passInput.focus();
      } else {
        userInput.focus();
      }
    });
  });
}
