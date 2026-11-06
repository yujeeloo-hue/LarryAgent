import { FolderOpen } from "lucide";
import { createLucideIcon } from "./originalIcons.js";
import { isImeComposing } from "./ime.js";
import "./edit-workspace-dialog.css";

export type EditWorkspaceDialogOptions = {
  title?: string;
  name: string;
  path: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onPickFolder?: () => Promise<string | null>;
};

export type EditWorkspaceDialogResult = {
  name: string;
  path: string;
} | null;

/**
 * Edit workspace name + folder path (Browse via host callback).
 */
export function showEditWorkspaceDialog(
  options: EditWorkspaceDialogOptions,
): Promise<EditWorkspaceDialogResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "edit-workspace-overlay";
    overlay.setAttribute("role", "presentation");

    const dialog = document.createElement("div");
    dialog.className = "edit-workspace-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "edit-workspace-title");

    const title = document.createElement("h2");
    title.id = "edit-workspace-title";
    title.className = "edit-workspace-title";
    title.textContent = options.title ?? "Edit workspace";

    const nameField = document.createElement("label");
    nameField.className = "edit-workspace-field";
    const nameLabel = document.createElement("span");
    nameLabel.className = "edit-workspace-label";
    nameLabel.textContent = "Name";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "edit-workspace-input";
    nameInput.value = options.name;
    nameInput.autocomplete = "off";
    nameInput.spellcheck = false;
    nameField.append(nameLabel, nameInput);

    const pathField = document.createElement("div");
    pathField.className = "edit-workspace-field";
    const pathLabel = document.createElement("span");
    pathLabel.className = "edit-workspace-label";
    pathLabel.textContent = "Folder";
    const pathRow = document.createElement("div");
    pathRow.className = "edit-workspace-path-row";
    const pathInput = document.createElement("input");
    pathInput.type = "text";
    pathInput.className = "edit-workspace-input edit-workspace-path-input";
    pathInput.value = options.path;
    pathInput.autocomplete = "off";
    pathInput.spellcheck = false;
    pathInput.readOnly = true;
    pathInput.title = options.path;

    const browseBtn = document.createElement("button");
    browseBtn.type = "button";
    browseBtn.className = "edit-workspace-browse";
    browseBtn.title = "Choose folder";
    browseBtn.setAttribute("aria-label", "Choose folder");
    browseBtn.append(
      createLucideIcon(FolderOpen, { size: 14 }),
      document.createTextNode("Browse"),
    );
    browseBtn.addEventListener("click", () => {
      void (async () => {
        if (!options.onPickFolder) return;
        const picked = await options.onPickFolder();
        if (!picked) return;
        pathInput.value = picked;
        pathInput.title = picked;
      })();
    });

    pathRow.append(pathInput, browseBtn);
    pathField.append(pathLabel, pathRow);

    const actions = document.createElement("div");
    actions.className = "edit-workspace-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "edit-workspace-btn edit-workspace-btn-cancel";
    cancelBtn.textContent = options.cancelLabel ?? "Cancel";

    const confirmBtn = document.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "edit-workspace-btn edit-workspace-btn-confirm action-primary";
    confirmBtn.textContent = options.confirmLabel ?? "Save";

    actions.append(cancelBtn, confirmBtn);
    dialog.append(title, nameField, pathField, actions);
    overlay.append(dialog);

    let settled = false;
    const finish = (value: EditWorkspaceDialogResult): void => {
      if (settled) return;
      settled = true;
      overlay.remove();
      window.removeEventListener("keydown", onKeyDown, true);
      resolve(value);
    };

    const submit = (): void => {
      const name = nameInput.value.trim() || options.name.trim();
      const path = pathInput.value.trim();
      if (!name || !path) {
        finish(null);
        return;
      }
      finish({ name, path });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    };

    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !isImeComposing(event)) {
        event.preventDefault();
        event.stopPropagation();
        submit();
      }
    });

    cancelBtn.addEventListener("click", () => finish(null));
    confirmBtn.addEventListener("click", () => submit());
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) finish(null);
    });

    window.addEventListener("keydown", onKeyDown, true);
    document.body.append(overlay);
    requestAnimationFrame(() => {
      nameInput.focus();
      nameInput.select();
    });
  });
}
