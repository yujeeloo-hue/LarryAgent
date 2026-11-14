import "./skill-dialog.css";
import { AppDropdown } from "../../ui/appDropdown.js";

export type SkillDialogDraft = {
  id?: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  /** Owning project slug; empty = universal. */
  project: string;
};

export type SkillDialogResult = SkillDialogDraft | null;

export type SkillDialogOptions = Partial<SkillDialogDraft> & {
  /** Project slugs already present in the library (picker choices). */
  projectOptions?: readonly string[];
};

/**
 * Modal dialog to add or edit a skill (name, description, project, body).
 */
export function showSkillDialog(
  initial?: SkillDialogOptions,
): Promise<SkillDialogResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "skill-dialog-overlay";
    overlay.setAttribute("role", "presentation");

    const dialog = document.createElement("div");
    dialog.className = "skill-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "skill-dialog-title");

    const title = document.createElement("h2");
    title.id = "skill-dialog-title";
    title.className = "skill-dialog-title";
    title.textContent = initial?.id ? "Edit skill" : "Add skill";

    const form = document.createElement("form");
    form.className = "skill-dialog-form";

    const nameField = fieldBlock("Name (slug)");
    const nameInput = document.createElement("input");
    nameInput.className = "skill-dialog-input";
    nameInput.type = "text";
    nameInput.required = true;
    nameInput.placeholder = "my-skill";
    nameInput.pattern = "[a-z0-9]+(-[a-z0-9]+)*";
    nameInput.title = "Lowercase letters, numbers, and hyphens";
    nameInput.value = initial?.name ?? "";
    nameField.append(nameInput);

    const descField = fieldBlock("Description");
    const descInput = document.createElement("textarea");
    descInput.className = "skill-dialog-textarea";
    descInput.rows = 3;
    descInput.required = true;
    descInput.maxLength = 1024;
    descInput.placeholder =
      "Third-person summary of what this skill does and when to use it.";
    descInput.value = initial?.description ?? "";
    descField.append(descInput);

    const projectField = fieldBlock("Project");
    const projectChoices = [...new Set(initial?.projectOptions ?? [])];
    const initialProject = (initial?.project ?? "").trim().toLowerCase();
    if (initialProject && !projectChoices.includes(initialProject)) {
      projectChoices.unshift(initialProject);
    }
    const projectPicker = new AppDropdown(
      [
        { value: "", label: "Universal" },
        ...projectChoices.map((slug) => ({ value: slug, label: slug })),
      ],
      initialProject,
      { className: "skill-dialog-project", ariaLabel: "Skill project" },
    );
    projectField.append(projectPicker.el);

    const bodyField = fieldBlock("Instructions (markdown body)");
    const bodyInput = document.createElement("textarea");
    bodyInput.className = "skill-dialog-textarea skill-dialog-body";
    bodyInput.rows = 12;
    bodyInput.placeholder = "# Title\n\n## Instructions\n…";
    bodyInput.value = initial?.body ?? "";
    bodyField.append(bodyInput);

    const enabledField = document.createElement("label");
    enabledField.className = "skill-dialog-check";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = initial?.enabled !== false;
    const enabledText = document.createElement("span");
    enabledText.textContent = "Enabled (include in agent catalog)";
    enabledField.append(enabledInput, enabledText);

    const errorEl = document.createElement("p");
    errorEl.className = "skill-dialog-error";
    errorEl.hidden = true;

    const actions = document.createElement("div");
    actions.className = "skill-dialog-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "skill-dialog-btn";
    cancelBtn.textContent = "Cancel";
    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "skill-dialog-btn skill-dialog-btn-confirm action-primary";
    saveBtn.textContent = "Save";
    actions.append(cancelBtn, saveBtn);

    form.append(
      nameField,
      descField,
      projectField,
      bodyField,
      enabledField,
      errorEl,
      actions,
    );
    dialog.append(title, form);
    overlay.append(dialog);
    document.body.append(overlay);

    const close = (result: SkillDialogResult) => {
      overlay.remove();
      window.removeEventListener("keydown", onKeyDown);
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // An open dropdown popup owns Escape (it is portaled to <body>).
        if (projectPicker.ownsEvent(event)) return;
        event.preventDefault();
        close(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(null);
    });
    cancelBtn.addEventListener("click", () => close(null));

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      errorEl.hidden = true;
      const name = nameInput.value.trim().toLowerCase();
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
        errorEl.textContent =
          "Name must be a lowercase slug (letters, numbers, hyphens; max 64).";
        errorEl.hidden = false;
        return;
      }
      const description = descInput.value.trim();
      if (!description) {
        errorEl.textContent = "Description is required.";
        errorEl.hidden = false;
        return;
      }
      const draft: SkillDialogDraft = {
        name,
        description,
        body: bodyInput.value,
        enabled: enabledInput.checked,
        project: projectPicker.value,
      };
      if (initial?.id) draft.id = initial.id;
      close(draft);
    });

    queueMicrotask(() => nameInput.focus());
  });
}

function fieldBlock(labelText: string): HTMLElement {
  const field = document.createElement("div");
  field.className = "skill-dialog-field";
  const label = document.createElement("label");
  label.className = "skill-dialog-label";
  label.textContent = labelText;
  field.append(label);
  return field;
}
