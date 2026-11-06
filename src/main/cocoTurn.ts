import type { StreamChatFn, SummarizeFn } from "../agent/types.js";
import type { SessionStore } from "./sessionRuntime.js";

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Compaction summaries for CoCo-owned turns go through the same metered stream as the turn. */
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

/**
 * Wait for a native turn to end. `tick` runs on every poll and may return true
 * to request a CoCo stop; the wait continues until the turn has actually ended.
 */
export async function waitForTurn(store: SessionStore, sessionId: string, tick: () => boolean | void, intervalMs = 50): Promise<void> {
  while (store.isTurnActive(sessionId)) {
    if (tick() === true) store.cancelTurn(sessionId, "coco_stopped");
    await sleep(intervalMs);
  }
}

/** Stop a turn CoCo still owns and wait until the session is quiet. */
export async function cancelOwnedTurn(store: SessionStore, sessionId: string | undefined, accessId: string): Promise<void> {
  if (!sessionId || !store.isCocoTurnActive(sessionId, accessId)) return;
  store.cancelTurn(sessionId, "coco_stopped");
  await waitForTurn(store, sessionId, () => {}, 20);
}
