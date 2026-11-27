import { parseAskAnswerResult, type HandoffPasswordDestination, type HandoffPasswordStatus, type HandoffPasswordSubmission, type UserAskAnswer, type UserAskOption } from "./askUser.js";

export type AskUserPanelInput = {
  question: string;
  detail?: string;
  options: string[];
  optionDetails?: UserAskOption[];
  allowCustom: boolean;
  allowMultiple?: boolean;
  hideQuestion?: boolean;
  draftKey?: string;
  handoffQrPng?: string;
  handoffPassword?: {
    destination: HandoffPasswordDestination;
    submit: (submission: HandoffPasswordSubmission) => Promise<HandoffPasswordStatus>;
  };
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
  let fillingPassword = false;
  if (!input.hideQuestion) {
    const question = document.createElement("p");
    question.className = "content-card-ask-user-question";
    question.textContent = input.question;
    root.append(question);
  }
  const context = document.createElement("p");
  context.className = "content-card-ask-user-context";
  context.textContent = input.detail?.trim() ? input.detail.trim() : open ? "Share your answer below." : multiple
    ? canWrite ? "Choose one or more options and add any details." : "Choose one or more options."
    : canWrite ? "Choose an option or write your own answer." : "Choose an option, then confirm.";
  root.append(context);
  if (input.handoffQrPng) {
    const qr = document.createElement("img");
    qr.className = "content-card-handoff-qr";
    qr.alt = "QR code to scan with your phone";
    qr.src = `data:image/png;base64,${input.handoffQrPng}`;
    qr.draggable = false;
    root.append(qr);
  }
  const passwordForm = input.handoffPassword
    ? createHandoffPasswordForm(input.handoffPassword, input.options[0] ?? "Done", busy => {
        fillingPassword = busy;
        sync();
      })
    : null;
  if (passwordForm) root.append(passwordForm);
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
      choice.disabled = settled || fillingPassword;
      choice.parentElement?.classList.toggle("is-selected", choice.checked);
    }
    if (textarea) {
      textarea.disabled = settled;
      textarea.placeholder = hasChoice ? "Add conditions or details to send with your selection…" : "Share your thoughts, requirements, or another approach…";
    }
    if (editorLabel) editorLabel.textContent = hasChoice ? "Additional details" : open ? "Your answer" : "Custom answer";
    if (optional) optional.textContent = hasChoice ? "Optional" : "";
    if (customButton) { customButton.hidden = !hasChoice; customButton.disabled = settled; }
    if (passwordForm) passwordForm.inert = settled;
    submit.disabled = settled || fillingPassword || (!hasChoice && !hasText);
    submit.textContent = hasChoice ? hasText ? "Confirm & send" : "Confirm selection" : "Send answer";
  }
  sync();
  return root;
}

function createHandoffPasswordForm(
  { destination, submit }: NonNullable<AskUserPanelInput["handoffPassword"]>,
  doneLabel: string,
  onBusy: (busy: boolean) => void,
): HTMLFormElement {
  const form = document.createElement("form");
  form.className = "content-card-handoff-password";
  const label = document.createElement("label");
  label.className = "content-card-handoff-password-label";
  label.textContent = `Password for ${destination.app}${destination.origin ? ` · ${destination.origin}` : ""}`;
  const field = document.createElement("input");
  field.className = "content-card-handoff-password-input";
  field.type = "password";
  field.autocomplete = "off";
  field.spellcheck = false;
  field.maxLength = 4096;
  field.id = `handoff-password-${panelSequence}`;
  label.htmlFor = field.id;

  const button = document.createElement("button");
  button.type = "submit";
  button.className = "content-card-ask-user-confirm action-primary";
  button.textContent = "Fill password";
  button.disabled = true;
  const entry = document.createElement("div");
  entry.className = "content-card-handoff-password-entry";
  entry.append(field, button);
  const status = document.createElement("p");
  status.className = "content-card-ask-user-hint";
  status.setAttribute("role", "status");
  status.textContent = "Sent directly to the password field on this device.";
  form.append(label, entry);
  let remember: HTMLInputElement | undefined;
  let account: HTMLInputElement | undefined;
  let savedAccount: HTMLSelectElement | undefined;
  let savedButton: HTMLButtonElement | undefined;
  if (destination.login) {
    const rememberLabel = document.createElement("label");
    rememberLabel.className = "content-card-handoff-remember";
    remember = document.createElement("input");
    remember.type = "checkbox";
    rememberLabel.append(remember, "Save login on this device");
    account = document.createElement("input");
    account.className = "content-card-handoff-password-input";
    account.type = "text";
    account.setAttribute("aria-label", "Account for this login");
    account.placeholder = "Account";
    account.autocomplete = "off";
    account.spellcheck = false;
    account.maxLength = 512;
    account.value = destination.login.account ?? "";
    account.readOnly = Boolean(destination.login.account);
    account.hidden = true;
    form.append(rememberLabel, account);
    if (destination.login.accounts.length > 0) {
      savedAccount = document.createElement("select");
      savedAccount.className = "content-card-handoff-password-input";
      savedAccount.setAttribute("aria-label", "Saved account");
      const prompt = document.createElement("option");
      prompt.value = "";
      prompt.textContent = "Choose a saved account";
      savedAccount.append(prompt);
      for (const username of destination.login.accounts) {
        const option = document.createElement("option");
        option.value = username;
        option.textContent = username;
        option.selected = destination.login.accounts.length === 1;
        savedAccount.append(option);
      }
      savedButton = document.createElement("button");
      savedButton.type = "button";
      savedButton.className = "content-card-ask-user-confirm";
      savedButton.textContent = "Use saved login";
      const savedRow = document.createElement("div");
      savedRow.className = "content-card-handoff-password-entry";
      savedRow.append(savedAccount, savedButton);
      form.insertBefore(savedRow, entry);
      savedAccount.addEventListener("change", syncInputs);
      savedButton.addEventListener("click", () => {
        if (savedAccount?.value) void send({ kind: "saved", account: savedAccount.value });
      });
    }
    remember.addEventListener("change", syncInputs);
    account.addEventListener("input", syncInputs);
  }
  form.append(status);
  let busy = false;
  function syncInputs() {
    const shouldRemember = remember?.checked === true;
    if (account) {
      account.hidden = !shouldRemember;
      account.disabled = busy || !shouldRemember;
    }
    if (remember) remember.disabled = busy;
    if (savedAccount) savedAccount.disabled = busy;
    if (savedButton) savedButton.disabled = busy || !savedAccount?.value;
    field.disabled = busy;
    button.disabled = busy || !field.value || (shouldRemember && !account?.value.trim());
  }
  field.addEventListener("input", syncInputs);
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (button.disabled || !field.value) return;
    const rememberAccount = remember?.checked ? account?.value.trim() : undefined;
    void send({
      kind: "manual", password: field.value,
      ...(rememberAccount ? { rememberAccount } : {}),
    });
  });
  async function send(submission: HandoffPasswordSubmission) {
    if (busy) return;
    field.value = "";
    busy = true;
    syncInputs();
    status.textContent = "Filling password…";
    onBusy(true);
    const result = await submit(submission).catch(() => "unavailable" as const);
    if (result === "filled") {
      status.textContent = "Password filled.";
    } else if (result === "filled_not_saved") {
      status.textContent = "Password filled. The login could not be saved.";
    } else if (result === "unavailable") {
      onBusy(false);
      status.textContent = `The password field could not be filled. Enter it in the app, then choose ${doneLabel}.`;
    } else if (result === "busy") {
      onBusy(false);
      status.textContent = "Another password submission is in progress.";
      busy = false;
      syncInputs();
    } else {
      status.textContent = "This request has ended.";
    }
  }
  syncInputs();
  return form;
}

const HANDOFF_OUTCOME_LABELS: Record<string, string> = {
  done: "Done",
  auto: "Done",
  confirmed: "Confirmed",
  declined: "Declined",
  skipped: "Skipped",
  resumed: "Resumed",
  stopped: "Task stopped",
  timeout: "Timed out",
  unanswered: "No answer",
};

const HANDOFF_VIA_LABELS: Record<string, string> = {
  screen: "On screen",
  conversation: "In the conversation",
  watch: "Detected automatically",
  timer: "No answer in time",
};

function waitedLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

export function createHandoffAnswerView(text: string): HTMLElement | null {
  let parsed: { outcome?: unknown; choice?: unknown; via?: unknown; waited_s?: unknown; password_filled?: unknown; password_present?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.outcome !== "string") return null;
  const choice = typeof parsed.choice === "string" ? parsed.choice : "";
  const label = parsed.outcome === "auto" && parsed.password_present === true
    ? "Password already filled"
    : parsed.outcome === "done" && parsed.password_filled === true
      ? "Password filled"
      : parsed.outcome === "chosen" ? (choice ? `Chose ${choice}` : "Chosen") : HANDOFF_OUTCOME_LABELS[parsed.outcome];
  if (!label) return null;
  const root = document.createElement("div");
  root.className = "content-card-ask-user-answer";
  const title = document.createElement("p");
  title.className = "content-card-ask-user-answer-title";
  title.textContent = label;
  root.append(title);
  const parts = [
    typeof parsed.via === "string" ? HANDOFF_VIA_LABELS[parsed.via] : undefined,
    typeof parsed.waited_s === "number" && parsed.waited_s > 0 ? waitedLabel(Math.round(parsed.waited_s)) : undefined,
  ].filter((part): part is string => Boolean(part));
  if (parts.length) {
    const line = document.createElement("p");
    line.className = "content-card-ask-user-answer-text";
    line.textContent = parts.join(" · ");
    root.append(line);
  }
  return root;
}

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
