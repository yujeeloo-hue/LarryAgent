import { createHash } from "node:crypto";
import type { OpenAiCompatibleClientConfig } from "./types.js";
import { modelEndpoint, resolveLlmApiProtocol } from "./apiProtocol.js";

/** Opaque local scope; credentials and provider reasoning never cross bindings. */
export function reasoningScopeForClient(client: OpenAiCompatibleClientConfig): string {
  const endpoint = modelEndpoint(client);
  const identity = [endpoint, client.model, client.apiKey];
  if (resolveLlmApiProtocol(client) === "responses") identity.push("responses");
  return createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex");
}
