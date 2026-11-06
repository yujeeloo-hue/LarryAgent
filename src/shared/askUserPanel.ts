import { parseAskAnswerResult, type UserAskAnswer, type UserAskOption } from "./askUser.js";

export type AskUserPanelInput = {
  question: string;
  options: string[];
  optionDetails?: UserAskOption[];
  allowCustom: boolean;
  allowMultiple?: boolean;
  hideQuestion?: boolean;
  /** Keep a local draft when the streamed card remounts. */
  draftKey?: string;
  onAnswer: (answer: UserAskAnswer) => void;
};
const drafts = new Map<string, { selected: string[]; text: string }>();
let panelSequence = 0;

export function createAskUserPanel(input: AskUserPanelInput): HTMLElement {
  const root = document.createElement("div");
  root.className = "content-card-ask-user";
  const open = input.options.length === 0;
  const multiple = !open && input.allowMultiple === true;
  const canWrite = open || input.allowCustom;
  const id = `ask-user-${++panelSequence}`;
  const saved = input.draftKey ? drafts.get(input.draftKey) : undefined;
  const labels = (saved?.selected ?? []).filter(label => input.options.includes(label));
  const selected = new Set(multiple ? labels : labels.slice(0, 1));
  let settled = false;
  if (!input.hideQuestion) {
    const question = document.createElement("p");
    question.className = "content-card-ask-user-question";
    question.textContent = input.question;
    root.append(question);
  }
  const context = document.createElement("p");
  context.className = "content-card-ask-user-context";
  context.textContent = open ? "Share your answer below." : multiple
    ? canWrite ? "Choose one or more options and add any details." : "Choose one or more options."
    : canWrite ? "Choose an option or write your own answer." : "Choose an option, then confirm.";
  root.append(context);
  const choices = document.createElement("fieldset");
  choices.className = "content-card-ask-user-options";
  choices.setAttribute("aria-label", multiple ? "Answer choices (multiple choice)" : "Answer choices");
  if (!open) root.append(choices);
  const controls: HTMLInputElement[] = [];
  const details = new Map(input.optionDetails?.map(option => [option.label, option]));
  input.options.forEach(label => {
    const row = document.createElement("label");
    row.className = "content-card-ask-user-option";
    const choice = document.createElement("input");
    choice.type = multiple ? "checkbox" : "radio";
    choice.name = `${id}-choice`;
    choice.value = label;
    choice.dataset.option = label;
    controls.push(choice);
    const copy = document.createElement("span");
    copy.className = "content-card-ask-user-option-text";
    const title = document.createElement("span");
    title.className = "content-card-ask-user-option-label";
    title.textContent = label;
    const detail = details.get(label);
    if (detail?.recommended) {
      const badge = document.createElement("span");
      badge.className = "content-card-ask-user-recommended";
      badge.textContent = "Recommended";
      title.append(badge);
    }
    copy.append(title);
    if (detail?.description) {
      const description = document.createElement("span");
      description.className = "content-card-ask-user-option-description";
      description.textContent = detail.description;
      copy.append(description);
    }
    row.append(choice, copy);
    choice.addEventListener("change", () => {
      if (settled) return;
      if (!multiple) selected.clear();
      if (choice.checked) selected.add(label); else selected.delete(label);
      sync(); save();
    });
    choices.append(row);
  });
  let textarea: HTMLTextAreaElement | undefined;
  let editorLabel: HTMLLabelElement | undefined;
  let optional: HTMLSpanElement | undefined;
  let customButton: HTMLButtonElement | undefined;
  if (canWrite) {
    const editor = document.createElement("div");
    editor.className = "content-card-ask-user-custom";
    const heading = document.createElement("div");
    heading.className = "content-card-ask-user-editor-heading";
    editorLabel = document.createElement("label");
    editorLabel.htmlFor = `${id}-text`;
    optional = document.createElement("span");
    optional.className = "content-card-ask-user-optional";
    customButton = document.createElement("button");
    customButton.type = "button";
    customButton.className = "content-card-ask-user-use-custom";
    customButton.textContent = "Use a custom answer";
    customButton.addEventListener("click", () => {
      if (settled) return;
      selected.clear(); sync(); save(); textarea?.focus();
    });
    heading.append(editorLabel, optional, customButton);
    textarea = document.createElement("textarea");
    textarea.id = `${id}-text`;
    textarea.className = "content-card-ask-user-custom-input";
    textarea.rows = 3;
    textarea.value = saved?.text ?? "";
    textarea.addEventListener("input", () => { sync(); save(); });
    textarea.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) &&
        !event.isComposing && event.keyCode !== 229 && !submit.disabled) {
        event.preventDefault(); submit.click();
      }
    });
    editor.append(heading, textarea);
    root.append(editor);
  }
  const footer = document.createElement("div");
  footer.className = "content-card-ask-user-footer";
  if (canWrite) {
    const hint = document.createElement("span");
    hint.className = "content-card-ask-user-hint";
    hint.textContent = "Enter for a new line · ⌘ / Ctrl + Enter to send";
    footer.append(hint);
  }
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "content-card-ask-user-confirm action-primary";
  submit.addEventListener("click", () => {
    if (settled || submit.disabled) return;
    const selections = input.options.filter(label => selected.has(label));
    const text = textarea?.value.trim() ?? "";
    if (!selections.length && !text) return;
    settled = true;
    sync();
    if (input.draftKey) drafts.delete(input.draftKey);
    input.onAnswer(selections.length ? {
      selected: selections.join(", "), ...(multiple ? { selections } : {}),
      custom: false, ...(text ? { comment: text } : {}),
    } : { selected: text, custom: true });
  });
  footer.append(submit);
  root.append(footer);
  function save(): void {
    if (!input.draftKey || settled) return;
    drafts.set(input.draftKey, { selected: [...selected], text: textarea?.value ?? "" });
    if (drafts.size > 100) drafts.delete(drafts.keys().next().value!);
  }
  function sync(): void {
    const hasChoice = selected.size > 0;
    const hasText = Boolean(textarea?.value.trim());
    for (const choice of controls) {
      choice.checked = selected.has(choice.value);
      choice.disabled = settled;
      choice.parentElement?.classList.toggle("is-selected", choice.checked);
    }
    if (textarea) {
      textarea.disabled = settled;
      textarea.placeholder = hasChoice ? "Add conditions or details to send with your selection…" : "Share your thoughts, requirements, or another approach…";
    }
    if (editorLabel) editorLabel.textContent = hasChoice ? "Additional details" : open ? "Your answer" : "Custom answer";
    if (optional) optional.textContent = hasChoice ? "Optional" : "";
    if (customButton) { customButton.hidden = !hasChoice; customButton.disabled = settled; }
    submit.disabled = settled || (!hasChoice && !hasText);
    submit.textContent = hasChoice ? hasText ? "Confirm & send" : "Confirm selection" : "Send answer";
  }
  sync();
  return root;
}

/** Human-readable settled state; the model receives the JSON result. */
export function createAskUserAnswerView(text: string, question?: string): HTMLElement | null {
  const result = parseAskAnswerResult(text);
  if (!result) return null;
  const root = document.createElement("div");
  root.className = "content-card-ask-user-answer";
  if (question) {
    const heading = document.createElement("p");
    heading.className = "content-card-ask-user-question";
    heading.textContent = question;
    root.append(heading);
  }
  const title = document.createElement("p");
  title.className = "content-card-ask-user-answer-title";
  title.textContent = "Answer sent";
  root.append(title);
  for (const [label, value] of [
    ["Selected", result.selected_options.join(", ")],
    ["Custom answer", result.custom_answer],
    ["Additional details", result.comment],
  ]) {
    if (!value) continue;
    const caption = document.createElement("p"); caption.className = "content-card-ask-user-answer-caption"; caption.textContent = label!;
    const content = document.createElement("p"); content.className = "content-card-ask-user-answer-text"; content.textContent = value;
    root.append(caption, content);
  }
  return root;
}
