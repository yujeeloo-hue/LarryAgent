import { createHash } from "node:crypto";
import type {
  OpenAiChatMessage,
  OpenAiToolDefinition,
} from "../llm/types.js";

export type PrefixSegmentId =
  | "env"
  | "identity"
  | "soul"
  | "user"
  | "project"
  | "baseAgent"
  | "extraSystem"
  | "skills"
  | "hooks"
  | "compactionSummary";

export type PrefixSegmentSummary = {
  id: PrefixSegmentId;
  present: boolean;
  hash: string | null;
  charLen: number;
};

export type RequestPrefixSummary = {
  segments: PrefixSegmentSummary[];
  toolsHash: string | null;
  toolsNames: string[];
  toolDefCount: number;
  messageCount: number;
  /** Index of first non-system / post-prefix message (transcript start). */
  transcriptStartIndex: number;
};

const SEGMENT_ORDER: readonly PrefixSegmentId[] = [
  "env",
  "identity",
  "soul",
  "user",
  "project",
  "baseAgent",
  "extraSystem",
  "skills",
  "hooks",
  "compactionSummary",
] as const;

function shortHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 12);
}

function contentAsString(content: OpenAiChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/**
 * Classify an ephemeral / synthetic system message by stable content markers.
 * Returns null for ordinary transcript system messages (rare).
 */
export function classifySystemContent(
  content: string,
): PrefixSegmentId | null {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("Environment context for this model iteration")) {
    return "env";
  }
  if (trimmed.startsWith("[IDENTITY]")) {
    return "identity";
  }
  if (trimmed.startsWith("[SOUL]")) {
    return "soul";
  }
  if (trimmed.startsWith("[USER]")) {
    return "user";
  }
  if (trimmed.startsWith("[PROJECT]")) {
    return "project";
  }
  if (trimmed.startsWith("[AGENT]")) {
    return "baseAgent";
  }
  if (trimmed.startsWith("[Skills]")) {
    return "skills";
  }
  if (trimmed.startsWith("[Hook context]")) {
    return "hooks";
  }
  if (trimmed.startsWith("Previous conversation summary:")) {
    return "compactionSummary";
  }
  if (trimmed.startsWith("[Subagent]")) {
    return "extraSystem";
  }
  // Legacy unmatched agent body (pre-[AGENT] label) — first unmatched system.
  return "baseAgent";
}

function emptySegment(id: PrefixSegmentId): PrefixSegmentSummary {
  return { id, present: false, hash: null, charLen: 0 };
}

/**
 * Hash ephemeral system prefix segments + tools for cross-round cache comparison.
 * Walks leading system messages until a non-system role (transcript).
 */
export function summarizeRequestPrefix(
  messages: OpenAiChatMessage[],
  tools?: OpenAiToolDefinition[],
): RequestPrefixSummary {
  const byId = new Map<PrefixSegmentId, PrefixSegmentSummary>();
  for (const id of SEGMENT_ORDER) {
    byId.set(id, emptySegment(id));
  }

  let transcriptStartIndex = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role !== "system") {
      transcriptStartIndex = i;
      break;
    }
    transcriptStartIndex = i + 1;
    const text = contentAsString(msg.content);
    const id = classifySystemContent(text);
    if (!id) continue;
    // Later duplicate of same id overwrites (should not happen in normal assembly).
    byId.set(id, {
      id,
      present: true,
      hash: shortHash(text),
      charLen: text.length,
    });
  }

  const toolList = tools ?? [];
  const toolsNames = toolList.map((t) => t.function.name);
  let toolsHash: string | null = null;
  if (toolList.length > 0) {
    try {
      toolsHash = shortHash(JSON.stringify(toolList));
    } catch {
      toolsHash = shortHash(toolsNames.join(","));
    }
  }

  return {
    segments: SEGMENT_ORDER.map((id) => byId.get(id)!),
    toolsHash,
    toolsNames,
    toolDefCount: toolList.length,
    messageCount: messages.length,
    transcriptStartIndex,
  };
}
