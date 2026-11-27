import { chatCompletionOnce } from "./openaiCompatibleClient.js";
import { agentLogInfo } from "../logging/agentLog.js";
import { noReasoningExtraBody } from "./reasoningDisable.js";
import { prepareVisionImage } from "./prepareVisionImage.js";
import type { JsonObject } from "../session/types.js";
import type { OpenAiCompatibleClientConfig, OpenAiContentPart } from "./types.js";

const DEFAULT_QUESTION =
  "Describe this image in 2-4 sentences. Include visible text, UI, diagrams, and other important details.";

const VISION_MAX_TOKENS = 1024;

export type RecognizeImageInput = {
  client: OpenAiCompatibleClientConfig;
  imagePath: string;
  mimeType: string;
  question?: string;
  signal?: AbortSignal;
};

export async function recognizeImage(
  input: RecognizeImageInput,
): Promise<string> {
  const prepared = await prepareVisionImage(input.imagePath, input.mimeType);
  const dataUrl = `data:${prepared.mimeType};base64,${prepared.base64}`;
  const question = input.question?.trim() || DEFAULT_QUESTION;
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
