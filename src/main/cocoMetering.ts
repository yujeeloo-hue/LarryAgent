import { randomUUID } from "node:crypto";
import type { StreamChatFn } from "../agent/types.js";
import { streamChatCompletion } from "../llm/openaiCompatibleClient.js";
import type { CocoUsageFn } from "./cocoServiceDeps.js";

const ESTIMATE_FLUSH_MS = 2000;

export function meteredStream(signal: AbortSignal, usage: CocoUsageFn): StreamChatFn {
  return async function* (client, options) {
    signal.throwIfAborted();
    const requestId = randomUUID();
    const inputEstimate = Math.ceil(Buffer.byteLength(JSON.stringify([options.messages, options.tools ?? []]), "utf8") / 2);
    let output = 0, reported = false, lastFlushAt = Date.now();
    usage(inputEstimate, true, requestId);
    try {
      for await (const event of streamChatCompletion(client, { ...options, signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal, nativeTools: [] })) {
        if (event.type === "usage") {
          const tokens = event.totalTokens ?? ((event.promptTokens ?? 0) + (event.completionTokens ?? 0));
          if (tokens > 0) { usage(tokens, false, requestId); reported = true; }
        }
        if (event.type === "text_delta" || event.type === "reasoning_delta") output += Buffer.byteLength(event.text, "utf8");
        if (!reported && Date.now() - lastFlushAt >= ESTIMATE_FLUSH_MS) {
          usage(inputEstimate + Math.ceil(output / 2), true, requestId);
          lastFlushAt = Date.now();
        }
        yield event;
      }
    } finally { if (!reported) usage(inputEstimate + Math.ceil(output / 2), true, requestId); }
  };
}
