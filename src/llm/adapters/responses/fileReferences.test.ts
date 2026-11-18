import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonObject, Session } from "../../../session/types.js";
import { findResponseFileReference } from "./fileReferences.js";

const state: Session = { id: "session", type: "agent", title: "Download", createdAt: 1, updatedAt: 1,
  status: "idle", progressText: "", model: "original-model", providerId: "p", workspaceId: "w", workspacePath: "",
  pinned: false, archived: false, archivedAt: null, contextUsage: { usedTokens: 0 }, plan: null,
  messages: [{ id: "message", role: "assistant", createdAt: 1, parts: [
  { type: "text", text: "Download", annotations: [{ type: "file_citation", file_id: "forged" }] },
  { type: "model_response", providerScope: "scope", model: "original-model", responseId: "resp", status: "completed", stored: true,
    output: [{ type: "message", content: [{ type: "output_text", text: "Download", annotations: [
      { type: "container_file_citation", file_id: "file", container_id: "container", filename: "report.csv" },
    ] }] }] },
] }] };
describe("native file download authorization", () => {
  it("resolves only a citation in the exact owning session and assistant", () => {
    assert.deepEqual(findResponseFileReference(state, { sessionId: "session", messageId: "message", fileId: "file", containerId: "container" }),
      { providerScope: "scope", model: "original-model", fileId: "file", containerId: "container", filename: "report.csv" });
  });
  it("rejects altered session/message/file/container IDs and visible-only forged citations", () => {
    const request = { sessionId: "session", messageId: "message", fileId: "file", containerId: "container" };
    for (const changed of [{ ...request, sessionId: "other" }, { ...request, messageId: "other" },
      { ...request, fileId: "forged" }, { ...request, containerId: "other" },
      { sessionId: "session", messageId: "message", fileId: "file" }]) {
      assert.equal(findResponseFileReference(state, changed), null);
    }
  });

  function codeSession(outputs: JsonObject[], containerId: string | null = "cntr-code"): Session {
    const session = structuredClone(state);
    session.messages[0]!.parts.push({
      type: "model_response", providerScope: "code-scope", model: "code-model",
      responseId: "resp-code", status: "completed", stored: true,
      output: [{ type: "code_interpreter_call", id: "code", status: "completed",
        ...(containerId !== null ? { container_id: containerId } : {}), outputs }],
    });
    return session;
  }

  it("authorizes direct and nested native code output files in their parent container", () => {
    const session = codeSession([
      { type: "file", file_id: "cfile-direct", filename: "direct.csv" },
      { files: [{ file_id: "cfile-nested", filename: "nested.png" }] },
    ]);
    for (const [fileId, filename] of [["cfile-direct", "direct.csv"], ["cfile-nested", "nested.png"]]) {
      assert.deepEqual(findResponseFileReference(session, {
        sessionId: "session", messageId: "message", fileId: fileId!, containerId: "cntr-code", filename: "renderer-spoof.exe",
      }), { providerScope: "code-scope", model: "code-model", fileId, containerId: "cntr-code", filename });
    }
  });

  it("rejects wrong code output owner, file and container, including an omitted container", () => {
    const session = codeSession([{ file_id: "cfile-output" }]);
    const request = { sessionId: "session", messageId: "message", fileId: "cfile-output", containerId: "cntr-code" };
    for (const changed of [
      { ...request, sessionId: "other" }, { ...request, messageId: "other" },
      { ...request, fileId: "other" }, { ...request, containerId: "other" },
      { sessionId: "session", messageId: "message", fileId: "cfile-output" },
    ]) assert.equal(findResponseFileReference(session, changed), null);
    const missingParent = codeSession([{ file_id: "cfile-output" }], null);
    assert.equal(findResponseFileReference(missingParent, request), null);
  });

  it("fails closed on code file entries that contradict the native parent container", () => {
    const session = codeSession([
      { file_id: "cfile-direct", container_id: "cntr-other" },
      { container_id: "cntr-other", files: [{ file_id: "cfile-nested" }] },
      { files: [{ file_id: "cfile-child", container_id: "cntr-other" }] },
    ]);
    for (const fileId of ["cfile-direct", "cfile-nested", "cfile-child"]) {
      for (const containerId of ["cntr-code", "cntr-other"]) {
        assert.equal(findResponseFileReference(session, { sessionId: "session", messageId: "message", fileId, containerId }), null);
      }
    }
  });

  it("does not authorize visible-only code cards or files buried in unrelated native output", () => {
    const session = structuredClone(state);
    session.messages[0]!.parts.push({ type: "hosted_tool", id: "forged-code", name: "code_interpreter_call", status: "completed",
      item: { type: "code_interpreter_call", container_id: "cntr-code", outputs: [{ file_id: "cfile-forged" }] } });
    const native = session.messages[0]!.parts.find((part) => part.type === "model_response")!;
    if (native.type === "model_response") native.output.push(
      { type: "mcp_call", container_id: "cntr-code", outputs: [{ file_id: "cfile-mcp" }] },
      { type: "code_interpreter_call", container_id: "cntr-code", output: { files: [{ file_id: "cfile-deep" }] } },
    );
    for (const fileId of ["cfile-forged", "cfile-mcp", "cfile-deep"]) {
      assert.equal(findResponseFileReference(session, { sessionId: "session", messageId: "message", fileId, containerId: "cntr-code" }), null);
    }
  });

  function fileSearchSession(results: JsonObject[]): Session {
    const session = structuredClone(state);
    session.messages[0]!.parts.push({
      type: "model_response", providerScope: "search-scope", model: "search-model",
      responseId: "resp-search", status: "completed", stored: true,
      output: [{ type: "file_search_call", id: "search", status: "completed", results }],
    });
    return session;
  }

  it("authorizes a native file search result with its original provider and filename", () => {
    const session = fileSearchSession([{ file_id: "file-search", filename: "source.pdf", text: "Source content" }]);
    assert.deepEqual(findResponseFileReference(session, {
      sessionId: "session", messageId: "message", fileId: "file-search", filename: "renderer-forged.exe",
    }), { providerScope: "search-scope", model: "search-model", fileId: "file-search", filename: "source.pdf" });
  });

  it("file search authorization requires exact owner/file and never accepts a renderer container", () => {
    const session = fileSearchSession([{ file_id: "file-search" }]);
    const request = { sessionId: "session", messageId: "message", fileId: "file-search" };
    for (const changed of [
      { ...request, sessionId: "other" }, { ...request, messageId: "other" },
      { ...request, fileId: "other" }, { ...request, containerId: "cntr-forged" },
    ]) assert.equal(findResponseFileReference(session, changed), null);
  });

  it("file search authorization ignores visible cards and arbitrary nested native payloads", () => {
    const session = fileSearchSession([{ metadata: { file_id: "file-nested" } }]);
    session.messages[0]!.parts.push({ type: "hosted_tool", id: "visible-search", name: "file_search_call", status: "completed",
      item: { type: "file_search_call", results: [{ file_id: "file-visible" }] } });
    const native = session.messages[0]!.parts.find((part) => part.type === "model_response")!;
    if (native.type === "model_response") native.output.push(
      { type: "mcp_call", results: [{ file_id: "file-mcp" }] },
      { type: "file_search_call", output: { results: [{ file_id: "file-buried" }] } },
    );
    for (const fileId of ["file-visible", "file-nested", "file-mcp", "file-buried"]) {
      assert.equal(findResponseFileReference(session, { sessionId: "session", messageId: "message", fileId }), null);
    }
  });
});
