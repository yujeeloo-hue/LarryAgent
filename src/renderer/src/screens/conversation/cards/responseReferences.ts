export type ResponseReference = {
  kind: "url" | "file";
  label: string;
  target: string;
  containerId?: string;
};

export type ResponseReferenceContext = { sessionId?: string; messageId?: string };

export function responseObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function shortText(value: unknown, max = 180): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Provider annotations are untrusted; only web URLs can navigate externally. */
export function responseReferencesFromAnnotations(value: unknown): ResponseReference[] {
  if (!Array.isArray(value)) return [];
  const references: ResponseReference[] = [];
  const seen = new Set<string>();
  for (const raw of value.slice(0, 100)) {
    const annotation = responseObject(raw);
    if (!annotation) continue;
    const citation = responseObject(annotation.url_citation) ?? annotation;
    const rawUrl = shortText(citation.url, 4096);
    if (rawUrl) {
      try {
        const url = new URL(rawUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") continue;
        if (url.username || url.password || seen.has(url.href)) continue;
        seen.add(url.href);
        references.push({
          kind: "url",
          label: shortText(citation.title) || url.hostname,
          target: url.href,
        });
      } catch {
        // Invalid or unsupported URLs remain non-interactive.
      }
      continue;
    }
    const fileId = shortText(annotation.file_id, 200);
    const containerId = shortText(annotation.container_id, 200);
    const key = `file:${containerId}:${fileId}`;
    if (!fileId || seen.has(key)) continue;
    seen.add(key);
    references.push({
      kind: "file",
      label: shortText(annotation.filename) || fileId,
      target: fileId,
      ...(containerId ? { containerId } : {}),
    });
  }
  return references;
}

export function createResponseReferences(
  references: ResponseReference[],
  context?: ResponseReferenceContext,
): HTMLElement | null {
  if (references.length === 0) return null;
  const container = document.createElement("div");
  container.className = "response-references";
  container.setAttribute("aria-label", "Sources");
  for (const reference of references) {
    if (reference.kind === "file") {
      const download = window.jellybot?.downloadResponseFile;
      if (download && context?.sessionId && context.messageId) {
        const file = document.createElement("button");
        file.type = "button";
        file.className = "response-reference response-reference-file response-reference-download";
        file.textContent = `Save ${reference.label}`;
        file.title = `Save file: ${reference.target}`;
        const feedback = document.createElement("span");
        feedback.className = "response-reference-feedback";
        feedback.setAttribute("role", "status");
        const sessionId = context.sessionId;
        const messageId = context.messageId;
        file.addEventListener("click", async (event) => {
          event.preventDefault(); event.stopPropagation();
          if (file.disabled) return;
          file.disabled = true;
          feedback.textContent = "Saving…";
          try {
            const result = await download({ sessionId, messageId, fileId: reference.target,
              ...(reference.containerId ? { containerId: reference.containerId } : {}),
              ...(reference.label !== reference.target ? { filename: reference.label } : {}) });
            feedback.textContent = result.ok ? "Saved" : result.cancelled ? "" : shortText(result.error, 200) || "Unable to save file.";
          } catch {
            feedback.textContent = "Unable to save file.";
          } finally { file.disabled = false; }
        });
        container.append(file, feedback);
        continue;
      }
      // Unowned references cannot authorize a provider download.
      const file = document.createElement("span");
      file.className = "response-reference response-reference-file";
      file.textContent = reference.label;
      file.title = `File: ${reference.target}`;
      container.append(file);
      continue;
    }
    const link = document.createElement("a");
    link.className = "response-reference md-link";
    link.href = reference.target;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = reference.label;
    link.title = reference.target;
    link.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void window.jellybot?.openExternal?.(reference.target);
    });
    container.append(link);
  }
  return container;
}
