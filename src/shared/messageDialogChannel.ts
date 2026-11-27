export const MESSAGE_DIALOG_REQUEST_CHANNEL = "message-dialog:request";
export const MESSAGE_DIALOG_REPLY_CHANNEL = "message-dialog:reply";

export type MessageDialogConfirmRequest = {
  id: string;
  message: string;
  title?: string;
  detail?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};
