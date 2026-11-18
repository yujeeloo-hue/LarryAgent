import type { StreamChatFn, SummarizeFn } from "../agent/types.js";
import type { SessionStore } from "./sessionRuntime.js";

export function summarizeFromStream(stream: StreamChatFn, signal: AbortSignal, meta?: { purpose: "compact" }): SummarizeFn {
  return async (client, options) => {
    let content = "";
    for await (const event of stream(client, { messages: options.messages, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal, ...(meta ? { meta } : {}) })) {
      if (event.type === "text_delta") content += event.text;
      if (event.type === "error") throw new Error(event.message);
    }
    return { content };
  };
}

export async function waitForTurn(store: SessionStore, sessionId: string, tick: () => boolean | void, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const unsubscribe = store.onTurnActivity((id) => { if (id === sessionId) poke(); });
    const cleanup = (): void => {
      unsubscribe();
      signal?.removeEventListener("abort", poke);
    };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const poke = (): void => {
      if (settled) return;
      let cancel = false;
      try { cancel = tick() === true; }
      catch (error) { fail(error); return; }
      if (cancel) {
        try { store.cancelTurn(sessionId, "coco_stopped"); }
        catch (error) { fail(error); return; }
      }
      if (!store.isTurnActive(sessionId)) finish();
    };
    if (signal) {
      if (signal.aborted) poke();
      else signal.addEventListener("abort", poke);
    }
    poke();
  });
}

export async function cancelOwnedTurn(store: SessionStore, sessionId: string | undefined, accessId: string): Promise<void> {
  if (!sessionId || !store.isCocoTurnActive(sessionId, accessId)) return;
  store.cancelTurn(sessionId, "coco_stopped");
  await waitForTurn(store, sessionId, () => {});
}
