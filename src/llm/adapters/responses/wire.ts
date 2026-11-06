import type { JsonObject } from "../../../session/types.js";
import type { OpenAiChatMessage } from "../../types.js";

/** Convert visible Chat history unless the owning binding supplies native output. */
export function responsesInputFromMessages(
  messages: readonly OpenAiChatMessage[],
  providerScope?: string,
): JsonObject[] {
  const input: JsonObject[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && providerScope &&
        message.responsesOutput?.providerScope === providerScope) {
      input.push(...message.responsesOutput.output);
      input.push(...(message.responsesOutput.continuationInput ?? []));
      continue;
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) throw new Error("Responses tool output is missing tool_call_id");
      // Tool-role images (read_image direct): chat-style content arrays map
      // to output parts — probe-verified shape on bigmodel's responses
      // gateway ([{type:"text"},{type:"image_url",image_url:{url}}]).
      const output = typeof message.content === "string" ? message.content
        : Array.isArray(message.content)
          ? message.content.map((part): JsonObject =>
              part.type === "text"
                ? { type: "text", text: part.text }
                : { type: "image_url", image_url: { url: part.image_url.url } })
          : "";
      input.push({ type: "function_call_output", call_id: message.tool_call_id, output });
      continue;
    }
    if (message.content !== null && (typeof message.content !== "string" || message.content.length > 0)) {
      const content = typeof message.content === "string" ? message.content
        : message.content.map((part): JsonObject => part.type === "text"
          ? { type: "input_text", text: part.text }
          : { type: "input_image", image_url: part.image_url.url, detail: part.image_url.detail ?? "auto" });
      input.push({ role: message.role, content });
    }
    for (const call of message.tool_calls ?? []) {
      input.push({ type: "function_call", call_id: call.id,
        name: call.function.name, arguments: call.function.arguments });
    }
  }
  return input;
}
