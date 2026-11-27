export type RecordedMessageDialog = {
  title: string;
  message: string;
  detail: string | null;
  cancellable: boolean;
};

export function installMessageDialogProbe(
  doc: Document,
  answer: (dialog: RecordedMessageDialog) => boolean = () => true,
): RecordedMessageDialog[] {
  const records: RecordedMessageDialog[] = [];
  const prototype = Object.getPrototypeOf(doc.createElement("dialog")) as {
    showModal?: (this: HTMLDialogElement) => void;
  };
  prototype.showModal = function showModal(this: HTMLDialogElement): void {
    const record: RecordedMessageDialog = {
      title: this.querySelector("#message-panel-title")?.textContent ?? "",
      message: this.querySelector("#message-panel-message")?.textContent ?? "",
      detail: this.querySelector("#message-panel-detail")?.textContent ?? null,
      cancellable: this.querySelector('button[value="cancel"]') !== null,
    };
    records.push(record);
    const confirmed = answer(record);
    queueMicrotask(() => {
      Object.defineProperty(this, "returnValue", {
        configurable: true,
        value: confirmed ? "confirm" : "cancel",
      });
      this.dispatchEvent(new (doc.defaultView ?? globalThis).Event("close"));
    });
  };
  return records;
}
