
export const DEV_MODE_REQUEST_CHANNEL = "devmode:request";
export const DEV_MODE_REPLY_CHANNEL = "devmode:reply";

export type DevModeReply = {
  ok: boolean;
  message?: string;
  data?: unknown;
};

export type DevModeRequestOwner = {
  id: number;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once?(event: "destroyed", listener: () => void): void;
  removeListener?(event: "destroyed", listener: () => void): void;
};

export type IpcSubscribe = (
  channel: string,
  handler: (senderId: number, payload: unknown) => void,
) => void;

export const DEV_MODE_REQUEST_TIMEOUT_MS = 8_000;

type PendingEntry = {
  ownerId: number;
  op: string;
  resolve: (reply: DevModeReply) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup: () => void;
};

const pending = new Map<number, PendingEntry>();
let nextId = 1;
let replyChannelRegistered = false;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function requestDevMode(
  owner: DevModeRequestOwner | null,
  op: string,
  payload: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<DevModeReply> {
  if (!owner || owner.isDestroyed()) {
    return Promise.reject(new Error("No application window"));
  }
  const timeoutMs =
    typeof options.timeoutMs === "number" &&
    Number.isFinite(options.timeoutMs) &&
    options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEV_MODE_REQUEST_TIMEOUT_MS;

  const id = nextId++;
  return new Promise<DevModeReply>((resolve, reject) => {
    const onDestroyed = (): void => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      reject(new Error("The application window closed before Dev Mode answered"));
    };
    const timer = setTimeout(() => {
      pending.delete(id);
      owner.removeListener?.("destroyed", onDestroyed);
      reject(new Error(`Dev Mode did not answer "${op}" within ${timeoutMs}ms`));
    }, timeoutMs);

    pending.set(id, {
      ownerId: owner.id,
      op,
      resolve,
      timer,
      cleanup: () => owner.removeListener?.("destroyed", onDestroyed),
    });
    owner.once?.("destroyed", onDestroyed);

    try {
      owner.send(DEV_MODE_REQUEST_CHANNEL, { id, op, payload });
    } catch (error) {
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.cleanup();
      }
      reject(new Error(`Could not reach the Dev Mode window — ${errorText(error)}`));
    }
  });
}

export function registerDevModeReplyChannel(subscribe: IpcSubscribe): void {
  if (replyChannelRegistered) return;
  replyChannelRegistered = true;
  subscribe(DEV_MODE_REPLY_CHANNEL, (senderId, payload) => {
    if (!payload || typeof payload !== "object") return;
    const message = payload as { id?: unknown; result?: unknown };
    if (typeof message.id !== "number") return;
    const entry = pending.get(message.id);
    if (!entry || entry.ownerId !== senderId) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.cleanup();
    const result = message.result;
    entry.resolve(
      result &&
        typeof result === "object" &&
        typeof (result as { ok?: unknown }).ok === "boolean"
        ? (result as DevModeReply)
        : { ok: false, message: "Malformed Dev Mode reply" },
    );
  });
}

export function resetDevModeRequests(): void {
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.cleanup();
  }
  pending.clear();
  replyChannelRegistered = false;
}

export function pendingDevModeRequestCount(): number {
  return pending.size;
}
