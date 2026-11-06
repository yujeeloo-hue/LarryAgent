import type { JsonObject, ModelResponsePart, Session } from "../../../session/types.js";

export type ResponseFileDownloadRequest = {
  sessionId: string;
  messageId: string;
  fileId: string;
  containerId?: string;
  filename?: string;
};
export type ResponseFileDownloadResult = { ok: boolean; cancelled?: boolean; path?: string; error?: string };

type ResolvedResponseFileReference = {
  providerScope: string; model?: string; fileId: string; containerId?: string; filename: string;
};

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null;
}

function matchReference(
  part: ModelResponsePart, file: JsonObject, containerId: string | undefined, request: ResponseFileDownloadRequest,
): ResolvedResponseFileReference | null {
  if (typeof file.file_id !== "string" || file.file_id !== request.fileId || containerId !== request.containerId) return null;
  return { providerScope: part.providerScope, ...(part.model ? { model: part.model } : {}),
    fileId: file.file_id, ...(containerId ? { containerId } : {}),
    filename: typeof file.filename === "string" && file.filename.trim() ? file.filename : file.file_id };
}

/** Only known native citation, file-search result and code-output positions authorize retrieval. */
export function findResponseFileReference(session: Session, request: ResponseFileDownloadRequest): ResolvedResponseFileReference | null {
  if (session.id !== request.sessionId) return null;
  const message = session.messages.find((candidate) => candidate.id === request.messageId && candidate.role === "assistant");
  if (!message) return null;
  for (const part of message.parts) {
    if (part.type !== "model_response") continue;
    for (const item of part.output) {
      if (item.type === "file_search_call") {
        if (!Array.isArray(item.results)) continue;
        for (const raw of item.results) {
          const result = object(raw);
          if (!result) continue;
          // File-search results belong to the provider file API, never a
          // container named by the renderer or an arbitrary nested payload.
          const reference = matchReference(part, result, undefined, request);
          if (reference) return reference;
        }
        continue;
      }
      if (item.type === "code_interpreter_call") {
        const containerId = typeof item.container_id === "string" && item.container_id.trim() ? item.container_id : undefined;
        if (!containerId || !Array.isArray(item.outputs)) continue;
        for (const raw of item.outputs) {
          const output = object(raw);
          if (!output || (output.container_id !== undefined && output.container_id !== containerId)) continue;
          const direct = matchReference(part, output, containerId, request);
          if (direct) return direct;
          if (!Array.isArray(output.files)) continue;
          for (const rawFile of output.files) {
            const file = object(rawFile);
            if (!file || (file.container_id !== undefined && file.container_id !== containerId)) continue;
            const nested = matchReference(part, file, containerId, request);
            if (nested) return nested;
          }
        }
        continue;
      }
      if (item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const content of item.content) {
        if (!content || typeof content !== "object" || Array.isArray(content) || !Array.isArray(content.annotations)) continue;
        for (const value of content.annotations) {
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const annotation: JsonObject = value;
          if (annotation.type !== "file_citation" && annotation.type !== "container_file_citation") continue;
          const containerId = typeof annotation.container_id === "string" ? annotation.container_id : undefined;
          const citation = matchReference(part, annotation, containerId, request);
          if (citation) return citation;
        }
      }
    }
  }
  return null;
}
