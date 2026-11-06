/**
 * Quick Open search worker — message plumbing only; the ranking state lives
 * in `quickOpenIndex.ts` so the controller can reuse it for the in-thread
 * fallback.
 *
 * The index is transferred once per tier (and extended in place as streamed
 * batches land), so per-keystroke traffic is just a query string out and at
 * most `limit` rows back — a six-figure index costs nothing per message.
 */
import {
  QuickOpenSearchIndex,
  type QuickOpenWorkerRequest,
  type QuickOpenWorkerResponse,
} from "./quickOpenIndex.js";

const index = new QuickOpenSearchIndex();

self.onmessage = (event: MessageEvent<QuickOpenWorkerRequest>): void => {
  const message = event.data;
  switch (message.type) {
    case "reset":
      index.reset();
      return;
    case "setTier":
      index.setTier(message.tier, message.files);
      return;
    case "appendTier":
      index.appendTier(message.tier, message.files);
      return;
    case "query": {
      const result = index.query(
        message.query,
        message.limit,
        message.engineOnly,
      );
      const response: QuickOpenWorkerResponse = {
        type: "results",
        id: message.id,
        ...result,
      };
      self.postMessage(response);
      return;
    }
  }
};
