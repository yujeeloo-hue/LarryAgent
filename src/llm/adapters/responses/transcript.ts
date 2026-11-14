import type { AssistantMessage, HostedToolPart, JsonObject, ToolCallPart } from "../../../session/types.js";
import { parseToolArgumentsRaw } from "../../../tools/validateToolArguments.js";
import { responseVisibleText } from "./context.js";

const hostedTypes = new Set(["web_search_call", "file_search_call", "code_interpreter_call",
  "image_generation_call", "mcp_call", "mcp_list_tools", "mcp_approval_request"]);

/** Only the latest native listing can attest to this server/tool's hint. */
function mcpReadOnlyHint(output: readonly JsonObject[], server: string, name: string): boolean | undefined {
  for (let index = output.length - 1; index >= 0; index -= 1) {
    const item = output[index]!;
    if (item.type !== "mcp_list_tools" || item.server_label !== server) continue;
    if (!Array.isArray(item.tools)) return undefined;
    const matches = item.tools.filter((tool) => tool && typeof tool === "object" && !Array.isArray(tool) && tool.name === name);
    if (matches.length !== 1) return undefined;
    const tool = matches[0];
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return undefined;
    const annotations = tool.annotations;
    if (!annotations || typeof annotations !== "object" || Array.isArray(annotations)) return undefined;
    return typeof annotations.readOnlyHint === "boolean" ? annotations.readOnlyHint : undefined;
  }
  return undefined;
}

/** An approval can execute remotely, so it must obey the final request policy. */
export function canApproveHostedMcp(
  approval: JsonObject | undefined,
  nativeTools: readonly JsonObject[],
  output: readonly JsonObject[] = [],
): boolean {
  if (approval?.type !== "mcp_approval_request" || typeof approval.server_label !== "string"
    || typeof approval.name !== "string" || !approval.name) return false;
  return nativeTools.some((tool) => {
    if (tool.type !== "mcp" || tool.server_label !== approval.server_label) return false;
    const filter = tool.allowed_tools;
    if (filter === undefined || filter === null) return true;
    if (Array.isArray(filter)) return filter.includes(approval.name!);
    if (typeof filter !== "object") return false;
    if ("tool_names" in filter && (!Array.isArray(filter.tool_names) || !filter.tool_names.includes(approval.name!))) return false;
    if ("read_only" in filter) {
      if (typeof filter.read_only !== "boolean") return false;
      return mcpReadOnlyHint(output, approval.server_label as string, approval.name as string) === filter.read_only;
    }
    return true;
  });
}

export function upsertHostedTool(assistant: AssistantMessage, update: Omit<HostedToolPart, "type">): HostedToolPart {
  const existing = assistant.parts.find((part): part is HostedToolPart => part.type === "hosted_tool" && part.id === update.id);
  if (existing) { Object.assign(existing, update); return existing; }
  const part: HostedToolPart = { type: "hosted_tool", ...update };
  assistant.parts.push(part);
  return part;
}

/** A finished HTTP stream cannot keep a local activity spinner running. */
export function sealHostedToolProgress(assistant: AssistantMessage): HostedToolPart[] {
  const changed: HostedToolPart[] = [];
  for (const part of assistant.parts) {
    if (part.type !== "hosted_tool" || part.status !== "in_progress") continue;
    part.status = "incomplete";
    changed.push(part);
  }
  return changed;
}

/** Materialize only visible data; encrypted output stays in model_response. */
export function applyResponsesOutput(assistant: AssistantMessage, output: JsonObject[], recoverFunctions = false): void {
  const visible = responseVisibleText(output);
  if (visible.text) {
    const text = assistant.parts.find((part) => part.type === "text");
    if (text?.type === "text") {
      text.text = visible.text;
      if (visible.annotations.length) text.annotations = visible.annotations;
    } else {
      assistant.parts.push({ type: "text", text: visible.text,
        ...(visible.annotations.length ? { annotations: visible.annotations } : {}) });
    }
  }
  for (const item of output) {
    if (item.type === "function_call") {
      // Recovery never executes a late function automatically. The regular
      // orphan repair seals it as unexecuted before the next model request.
      if (!recoverFunctions || typeof item.call_id !== "string" || typeof item.name !== "string") continue;
      if (assistant.parts.some((part) => part.type === "tool_call" && part.id === item.call_id)) continue;
      const raw = typeof item.arguments === "string" ? item.arguments : "{}";
      const parsed = parseToolArgumentsRaw(raw);
      const call: ToolCallPart = { type: "tool_call", id: item.call_id, name: item.name, status: "pending",
        arguments: parsed.ok ? parsed.value : {}, argumentsRaw: raw };
      if (!parsed.ok) call.argumentsError = parsed.error;
      assistant.parts.push(call);
    } else if (typeof item.type === "string" && hostedTypes.has(item.type)) {
      if (typeof item.id !== "string") continue;
      const status = item.status === "failed" || item.error != null ? "failed"
        : ["incomplete", "in_progress", "queued", "searching", "interpreting", "generating", "calling"].includes(String(item.status)) || (item.type === "mcp_approval_request" && !output.some(
          (answer) => answer.type === "mcp_approval_response" && answer.approval_request_id === item.id,
        )) ? "incomplete" : "completed";
      upsertHostedTool(assistant, { id: item.id, name: item.type.replace(/_call$/, ""), status, item });
    }
    // Other item types carry no visible transcript data; replay validity is
    // decided by hasUnsupportedResponsesCall before the part is reused.
  }
}

/** A call the local runner cannot answer would make every continuation of this response fail. */
export function hasUnsupportedResponsesCall(output: readonly JsonObject[]): boolean {
  return output.some((item) => typeof item.type !== "string" || (/_call$/.test(item.type)
    && item.type !== "function_call" && !hostedTypes.has(item.type)));
}

/** Answer every approval request of a response that has no recorded decision yet. */
export function denyUnansweredApprovals(output: readonly JsonObject[], answers: readonly JsonObject[] = []): JsonObject[] | undefined {
  const answered = new Set([...output, ...answers].filter((item) => item.type === "mcp_approval_response")
    .map((item) => item.approval_request_id));
  const missing = output.filter((item) => item.type === "mcp_approval_request" && typeof item.id === "string" && !answered.has(item.id));
  if (!missing.length) return undefined;
  return [...answers, ...missing.map((item): JsonObject => ({ type: "mcp_approval_response", approval_request_id: item.id!, approve: false }))];
}

/** A continuation whose outcome is lost must never re-send a positive approval. */
export function denyApprovals(answers: readonly JsonObject[] | undefined): JsonObject[] | undefined {
  return answers?.map((answer) => answer.type === "mcp_approval_response" && answer.approve === true
    ? { ...answer, approve: false } : answer);
}
