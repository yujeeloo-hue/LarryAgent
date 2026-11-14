import { randomUUID } from "node:crypto";
import type { StreamChatFn } from "../agent/types.js";
import { streamChatCompletion } from "../llm/openaiCompatibleClient.js";
import type { CocoUsageFn } from "./cocoServiceDeps.js";

/**
 * Each usage() call is a DB upsert plus a full budget re-evaluation, so the
 * growing mid-stream estimate is flushed at most this often (never per token).
 */
const ESTIMATE_FLUSH_MS = 2000;

/** Account each provider request once; stream usage updates replace, not add. */
export function meteredStream(signal: AbortSignal, usage: CocoUsageFn): StreamChatFn {
  return async function* (client, options) {
    signal.throwIfAborted();
    const requestId = randomUUID();
    const inputEstimate = Math.ceil(Buffer.byteLength(JSON.stringify([options.messages, options.tools ?? []]), "utf8") / 2);
    let output = 0, reported = false, lastFlushAt = Date.now();
    usage(inputEstimate, true, requestId); // Persist an estimate before network admission.
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
