import { ipcMain, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import {
  MESSAGE_DIALOG_REPLY_CHANNEL,
  MESSAGE_DIALOG_REQUEST_CHANNEL,
  type MessageDialogConfirmRequest,
} from "../shared/messageDialogChannel.js";

type Pending = { ownerId: number; settle: (ok: boolean) => void };

const pending = new Map<string, Pending>();
let replyListenerInstalled = false;

function installReplyListener(): void {
  if (replyListenerInstalled) return;
  replyListenerInstalled = true;
  ipcMain.on(MESSAGE_DIALOG_REPLY_CHANNEL, (event, id: unknown, ok: unknown) => {
    if (typeof id !== "string") return;
    const entry = pending.get(id);
    if (!entry || entry.ownerId !== event.sender.id) return;
    entry.settle(ok === true);
  });
}

export function confirmInRenderer(
  owner: WebContents,
  request: Omit<MessageDialogConfirmRequest, "id">,
): Promise<boolean> {
  installReplyListener();
  if (owner.isDestroyed()) return Promise.resolve(false);
  const id = randomUUID();
  return new Promise((resolve) => {
    const onGone = (): void => settle(false);
    const settle = (ok: boolean): void => {
      if (!pending.delete(id)) return;
      if (!owner.isDestroyed()) owner.off("destroyed", onGone);
      resolve(ok);
    };
    pending.set(id, { ownerId: owner.id, settle });
    owner.once("destroyed", onGone);
    owner.send(MESSAGE_DIALOG_REQUEST_CHANNEL, { ...request, id });
  });
}
