import { reasoningScopeForClient } from "../../contextScope.js";
import type { LlmApiAdapter } from "../../canonicalTypes.js";
import { messagesForBinding } from "../messagesForBinding.js";
import { prepareResponsesContext } from "./context.js";
import { responsesOnce, streamResponses } from "./http.js";

/** Responses API adapter. */
export const responsesAdapter: LlmApiAdapter = {
  id: "responses",
  hostedTools(client) {
    return client.responsesTools ?? [];
  },
  messagesForBinding,
  requestExtraBody(_client, extra) {
    return extra;
  },
  stream(config, options) {
    return streamResponses(config, options);
  },
  complete(config, options) {
    return responsesOnce(config, options);
  },
  prepareServerContext(messages, client) {
    return prepareResponsesContext(messages, client);
  },
  matchesReplayScope(client, scope) {
    return reasoningScopeForClient(client) === scope;
  },
};
