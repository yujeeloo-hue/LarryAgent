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
        message.includeEngine,
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
