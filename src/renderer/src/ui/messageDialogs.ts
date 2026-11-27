import {
  functionalIconSvg,
  type FunctionalIconName,
} from "../../../shared/icons/functionalIcons.js";
import { claimDevModal } from "../devmode/modalLayer.js";
import "./message-dialog.css";

export type AlertKind = "info" | "warning" | "error";

export interface AlertOptions {
  title?: string;
  type?: AlertKind;
}

export interface ConfirmOptions {
  title?: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

interface MessageDialogOptions {
  title: string;
  message: string;
  detail?: string;
  tone: "info" | "warning" | "danger";
  icon: FunctionalIconName;
  confirmLabel: string;
  cancelLabel?: string;
}

const alertAppearance = {
  info: { tone: "info", icon: "CircleCheck" },
  warning: { tone: "warning", icon: "TriangleAlert" },
  error: { tone: "danger", icon: "CircleX" },
} as const;

let dialogQueue: Promise<void> = Promise.resolve();

export async function showAlert(message: string, options: AlertOptions = {}): Promise<void> {
  await enqueueDialog({
    title: options.title?.trim() || "Notice",
    message: message.trim() || "Something went wrong.",
    confirmLabel: "OK",
    ...alertAppearance[options.type ?? "warning"],
  });
}

export function showConfirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  const detail = options.detail?.trim();
  return enqueueDialog({
    title: options.title?.trim() || "Confirm",
    message: message.trim() || "Are you sure?",
    ...(detail ? { detail } : {}),
    tone: options.destructive ? "danger" : "info",
    icon: options.destructive ? "Trash2" : "CircleHelp",
    confirmLabel: options.confirmLabel?.trim() || "OK",
    cancelLabel: options.cancelLabel?.trim() || "Cancel",
  });
}

function enqueueDialog(options: MessageDialogOptions): Promise<boolean> {
  const result = dialogQueue.then(() => openDialog(options));
  dialogQueue = result.then(() => undefined, () => undefined);
  return result;
}

function openDialog(options: MessageDialogOptions): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "message-panel";
  dialog.dataset.tone = options.tone;
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-labelledby", "message-panel-title");
  dialog.setAttribute(
    "aria-describedby",
    options.detail ? "message-panel-message message-panel-detail" : "message-panel-message",
  );
  if (!options.cancelLabel) dialog.setAttribute("role", "alertdialog");

  const form = document.createElement("form");
  form.method = "dialog";
  const content = document.createElement("div");
  content.className = "message-panel-content";
  const icon = document.createElement("span");
  icon.className = "message-panel-icon";
  icon.setAttribute("aria-hidden", "true");
  const artwork = encodeURIComponent(functionalIconSvg(options.icon, 22));
  icon.style.setProperty("--panel-artwork", `url("data:image/svg+xml,${artwork}")`);

  const copy = document.createElement("div");
  copy.className = "message-panel-copy";
  const title = document.createElement("h2");
  title.id = "message-panel-title";
  title.textContent = options.title;
  const message = document.createElement("p");
  message.id = "message-panel-message";
  message.textContent = options.message;
  copy.append(title, message);
  if (options.detail) {
    const detail = document.createElement("p");
    detail.id = "message-panel-detail";
    detail.textContent = options.detail;
    copy.append(detail);
  }
  content.append(icon, copy);

  const actions = document.createElement("div");
  actions.className = "message-panel-actions";
  if (options.cancelLabel) {
    const cancel = document.createElement("button");
    cancel.className = "message-panel-button";
    cancel.type = "submit";
    cancel.value = "cancel";
    cancel.textContent = options.cancelLabel;
    cancel.autofocus = true;
    actions.append(cancel);
  }
  const confirm = document.createElement("button");
  const action = options.cancelLabel && options.tone === "danger" ? "danger" : "primary";
  confirm.className = `message-panel-button message-panel-accept action-${action}`;
  confirm.type = "submit";
  confirm.value = "confirm";
  confirm.textContent = options.confirmLabel;
  confirm.autofocus = !options.cancelLabel;
  actions.append(confirm);

  form.append(content, actions);
  dialog.append(form);
  dialog.addEventListener("keydown", (event) => event.stopPropagation());
  document.body.append(dialog);
  try {
    dialog.showModal();
  } catch (error) {
    dialog.remove();
    throw error;
  }

  const releaseModal = claimDevModal();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      releaseModal();
      dialog.remove();
      resolve(dialog.returnValue === "confirm");
    }, { once: true });
  });
}
