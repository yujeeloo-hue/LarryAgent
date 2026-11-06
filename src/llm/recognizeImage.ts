import { chatCompletionOnce } from "./openaiCompatibleClient.js";
import { agentLogInfo } from "../logging/agentLog.js";
import { noReasoningExtraBody } from "./reasoningDisable.js";
import { prepareVisionImage } from "./prepareVisionImage.js";
import type { JsonObject } from "../session/types.js";
import type { OpenAiCompatibleClientConfig, OpenAiContentPart } from "./types.js";

const DEFAULT_QUESTION =
  "Describe this image in 2-4 sentences. Include visible text, UI, diagrams, and other important details.";

/** Cap completion budget; local reasoning models spend many tokens on thinking. */
const VISION_MAX_TOKENS = 1024;

export type RecognizeImageInput = {
  client: OpenAiCompatibleClientConfig;
  /** Absolute path to a local image file. */
  imagePath: string;
  mimeType: string;
  /** Optional focus question for the vision model. */
  question?: string;
  signal?: AbortSignal;
};

/**
 * Call an OpenAI-compatible vision model with a local image (base64 data URL)
 * and return the text description for the chat LLM.
 */
export async function recognizeImage(
  input: RecognizeImageInput,
): Promise<string> {
  const prepared = await prepareVisionImage(input.imagePath, input.mimeType);
  const dataUrl = `data:${prepared.mimeType};base64,${prepared.base64}`;
  const question = input.question?.trim() || DEFAULT_QUESTION;
  // Always-on diagnostics for vision 429/quota triage: enough to reconstruct
  // what the provider received without enabling full request-body logging.
  agentLogInfo("vision.request", {
    model: input.client.model,
    baseUrl: input.client.baseUrl,
    imagePath: input.imagePath,
    sourceMime: input.mimeType,
    wireMime: prepared.mimeType,
    mode: prepared.mode,
    ...(prepared.sourceWidth !== undefined
      ? { sourceWidth: prepared.sourceWidth, sourceHeight: prepared.sourceHeight }
      : {}),
    ...(prepared.width !== undefined
      ? { wireWidth: prepared.width, wireHeight: prepared.height }
      : {}),
    wireBytes: Buffer.byteLength(prepared.base64, "base64"),
    dataUrlChars: dataUrl.length,
    detail: "low",
    maxTokens: VISION_MAX_TOKENS,
  });

  const userContent: OpenAiContentPart[] = [
    { type: "text", text: question },
    {
      type: "image_url",
      image_url: { url: dataUrl, detail: "low" },
    },
  ];

  const onceOptions: {
    messages: Array<{
      role: "system" | "user";
      content: string | OpenAiContentPart[];
    }>;
    signal?: AbortSignal;
    meta: { purpose: "vision" };
    extraBody: JsonObject;
  } = {
    messages: [
      {
        role: "system",
        content:
          "You are a vision assistant. Reply with a concise, accurate description for another language model that cannot see the image. Do not refuse.",
      },
      { role: "user", content: userContent },
    ],
    meta: { purpose: "vision" },
    // thinking-off; no forced temperature — Kimi K models allow exactly one
    // value per mode, any fixed number 400s on some provider.
    extraBody: noReasoningExtraBody(input.client.baseUrl, {
      max_tokens: VISION_MAX_TOKENS,
    }),
  };
  if (input.signal) {
    onceOptions.signal = input.signal;
  }

  const result = await chatCompletionOnce(input.client, onceOptions);
  return result.content;
}
