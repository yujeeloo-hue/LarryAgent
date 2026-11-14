import {
  createResponseReferences,
  responseObject,
  responseReferencesFromAnnotations,
  type ResponseReferenceContext,
} from "./responseReferences.js";

export type HostedToolCardInput = {
  id: string;
  name: string;
  status: string;
  item?: unknown;
  referenceContext?: ResponseReferenceContext;
};

export const HOSTED_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

function imagePreview(item: Record<string, unknown>): HTMLElement | null {
  const encoded = item.result;
  if (typeof encoded !== "string" || !encoded) return null;
  const maxEncoded = 4 * Math.ceil(HOSTED_IMAGE_MAX_BYTES / 3);
  let mime = "";
  let decoded: string | undefined;
  if (encoded.length <= maxEncoded && encoded.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
    if (encoded.length / 4 * 3 - padding <= HOSTED_IMAGE_MAX_BYTES) {
      try {
        const signature = atob(encoded.slice(0, 32));
        if (signature.startsWith("\x89PNG\r\n\x1a\n")) mime = "image/png";
        else if (signature.startsWith("\xff\xd8\xff")) mime = "image/jpeg";
        else if (signature.startsWith("RIFF") && signature.slice(8, 12) === "WEBP") mime = "image/webp";
        const format = text(item.output_format, 20).toLowerCase();
        const expected = format === "jpg" ? "jpeg" : format;
        if (expected && mime !== `image/${expected}`) mime = "";
        if (mime) decoded = atob(encoded);
      } catch {
        mime = "";
      }
    }
  }
  const container = document.createElement("div");
  container.className = "content-card-hosted-image";
  if (!mime || !decoded) {
    container.classList.add("content-card-tool-summary");
    container.textContent = "Image preview unavailable: unsupported or oversized output.";
    return container;
  }
  // The DOM holds a short blob URL rather than another full base64 copy.
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  const imageUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const image = document.createElement("img");
  image.className = "conversation-image content-card-hosted-image-preview";
  image.alt = "Generated image";
  image.decoding = "async";
  // Eager loading also releases the URL if a refresh replaces the card before
  // it enters the viewport. Revoking after load preserves the displayed image.
  const release = (): void => URL.revokeObjectURL(imageUrl);
  image.addEventListener("load", release, { once: true });
  image.addEventListener("error", () => {
    release();
    container.classList.add("content-card-tool-summary");
    container.textContent = "Failed to load generated image.";
  }, { once: true });
  image.src = imageUrl;
  container.append(image);
  return container;
}

function text(value: unknown, max = 220): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function activityName(name: string): string {
  if (name.startsWith("web_search")) return "Web search";
  if (name.startsWith("file_search")) return "File search";
  if (name.startsWith("code_interpreter")) return "Code interpreter";
  if (name.startsWith("image_generation")) return "Image generation";
  if (name === "mcp_list_tools") return "MCP tools";
  if (name === "mcp_approval_request") return "MCP approval";
  if (name.startsWith("mcp")) return "MCP tool";
  if (name.startsWith("computer")) return "Computer activity";
  return text(name.replaceAll("_", " "), 100) || "Hosted tool";
}

function itemSummary(name: string, item: Record<string, unknown>): string {
  const error = responseObject(item.error);
  const failure = text(item.error) || text(error?.message) || text(error?.code);
  if (failure) return failure;
  const action = responseObject(item.action);
  if (name.startsWith("web_search")) {
    return text(action?.query) ||
      (Array.isArray(action?.queries)
        ? action.queries.slice(0, 3).map((query) => text(query, 80)).filter(Boolean).join(" · ")
        : "") || text(action?.url);
  }
  if (name.startsWith("file_search")) {
    return Array.isArray(item.queries)
      ? item.queries.slice(0, 3).map((query) => text(query, 80)).filter(Boolean).join(" · ")
      : "";
  }
  if (name.startsWith("mcp")) {
    return [text(item.server_label, 80), text(item.name, 100)].filter(Boolean).join(" · ");
  }
  if (name.startsWith("image_generation") && typeof item.result === "string" && item.result) {
    return "Image generated";
  }
  return "";
}

/** Compact provider activity, deliberately separate from executable local calls. */
export function createHostedToolCard(input: HostedToolCardInput): HTMLElement {
  const item = responseObject(input.item);
  // MCP items carry their actual operation in `name`; their native `type`
  // still identifies the hosted activity and keeps it out of local tool UI.
  const nativeType = text(item?.type, 100) || input.name;
  const status = ["in_progress", "completed", "failed", "incomplete"].includes(input.status)
    ? input.status
    : "incomplete";
  const card = document.createElement("section");
  card.className = "content-card content-card-hosted-tool";
  card.dataset.hostedToolId = input.id;
  card.dataset.hostedStatus = status;
  if (status === "in_progress") card.classList.add("content-card-tool-running");
  if (status === "failed" || status === "incomplete") card.classList.add("content-card-tool-error");
  const header = document.createElement("div");
  header.className = "content-card-tool-header";
  const title = document.createElement("div");
  title.className = "content-card-tool-title";
  const name = document.createElement("span");
  name.className = "content-card-tool-name";
  name.textContent = activityName(nativeType);
  const state = document.createElement("span");
  state.className = "content-card-tool-status";
  state.setAttribute("role", "status");
  state.textContent = status === "in_progress" ? "Running" :
    status === "completed" ? "Completed" : status === "failed" ? "Failed" : "Incomplete";
  title.append(name, state);
  header.append(title);
  if (item) {
    const summary = itemSummary(nativeType, item);
    if (summary) {
      const description = document.createElement("div");
      description.className = "content-card-tool-summary";
      description.textContent = summary;
      header.append(description);
    }
    // Read only documented reference locations. Never stringify native output:
    // image base64, encrypted reasoning and arbitrary MCP payloads stay opaque.
    const action = responseObject(item.action);
    const candidates: unknown[] = [];
    if (action) {
      candidates.push(action);
      if (Array.isArray(action.sources)) candidates.push(...action.sources.slice(0, 30));
    }
    if (Array.isArray(item.results)) candidates.push(...item.results.slice(0, 30));
    if (Array.isArray(item.outputs)) {
      const isCode = nativeType.startsWith("code_interpreter");
      const codeContainer = typeof item.container_id === "string" && item.container_id.trim() ? item.container_id : "";
      for (const output of item.outputs.slice(0, 30)) {
        const entry = responseObject(output);
        if (!entry) continue;
        if (isCode && (!codeContainer || (entry.container_id !== undefined && entry.container_id !== codeContainer))) continue;
        candidates.push({ ...entry, container_id: isCode ? codeContainer : entry.container_id ?? item.container_id });
        if (Array.isArray(entry.files)) {
          for (const file of entry.files.slice(0, 30)) {
            const fileEntry = responseObject(file);
            if (!fileEntry || (isCode && fileEntry.container_id !== undefined && fileEntry.container_id !== codeContainer)) continue;
            candidates.push({ ...fileEntry, container_id: isCode ? codeContainer : fileEntry.container_id ?? entry.container_id ?? item.container_id });
          }
        }
      }
    }
    if (Array.isArray(item.annotations)) candidates.push(...item.annotations.slice(0, 30));
    if (item.file_id) candidates.push(item);
    const references = createResponseReferences(responseReferencesFromAnnotations(candidates), input.referenceContext);
    if (references) header.append(references);
    if (nativeType.startsWith("image_generation") && status === "completed") {
      const preview = imagePreview(item);
      if (preview) header.append(preview);
    }
  }
  card.append(header);
  return card;
}
