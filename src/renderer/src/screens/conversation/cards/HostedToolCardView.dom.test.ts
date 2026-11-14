import assert from "node:assert/strict";
import { before, test } from "node:test";
import { parseHTML } from "linkedom";
import { resolveObjectURL } from "node:buffer";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window });
let createHostedToolCard: typeof import("./HostedToolCardView.js")["createHostedToolCard"];
let references: typeof import("./responseReferences.js");
before(async () => {
  ({ createHostedToolCard } = await import("./HostedToolCardView.js"));
  references = await import("./responseReferences.js");
});

test("hosted activities show their own status without executable local controls", () => {
  for (const [name, label] of [
    ["web_search_call", "Web search"], ["file_search_call", "File search"],
    ["code_interpreter_call", "Code interpreter"], ["mcp_call", "MCP tool"],
    ["image_generation_call", "Image generation"],
  ]) {
    for (const [status, state] of [
      ["in_progress", "Running"], ["completed", "Completed"],
      ["failed", "Failed"], ["incomplete", "Incomplete"],
    ]) {
      const card = createHostedToolCard({ id: "native-id", name: name!, status: status! });
      assert.match(card.textContent!, new RegExp(label!));
      assert.equal(card.querySelector('[role="status"]')?.textContent, state);
      assert.equal(card.dataset.hostedToolId, "native-id");
      assert.equal(card.querySelector("button, [data-tool-call-id]"), null);
    }
  }
});

test("web references open safely in the external browser and duplicate sources collapse", () => {
  const opened: string[] = [];
  window.jellybot = { openExternal: async (url: string) => { opened.push(url); return true; } } as unknown as NonNullable<Window["jellybot"]>;
  const card = createHostedToolCard({
    id: "search", name: "web_search_call", status: "completed",
    item: { action: { query: "Responses API", sources: [
      { url: "https://example.com/docs", title: "Official docs" },
      { url: "https://example.com/docs", title: "Duplicate" },
      { url: "javascript:alert(1)", title: "Bad" },
      { url: "file:///secret", title: "Local" },
    ] } },
  });
  assert.match(card.textContent!, /Responses API/);
  const links = card.querySelectorAll("a");
  assert.equal(links.length, 1);
  assert.equal(links[0]!.textContent, "Official docs");
  links[0]!.dispatchEvent(new dom.window.Event("click", { bubbles: true, cancelable: true }));
  assert.deepEqual(opened, ["https://example.com/docs"]);
});

test("file and code output IDs remain references without pretending to be local paths", () => {
  const fileCard = createHostedToolCard({
    id: "files", name: "file_search_call", status: "completed",
    item: { queries: ["budget"], results: [{ file_id: "file-budget", filename: "budget.pdf" }] },
  });
  assert.match(fileCard.textContent!, /budget.pdf/);
  assert.equal(fileCard.querySelector(".response-reference-file")?.getAttribute("title"), "File: file-budget");
  assert.equal(fileCard.querySelector("a"), null);
  const codeCard = createHostedToolCard({
    id: "code", name: "code_interpreter_call", status: "completed",
    item: { container_id: "cntr-code", outputs: [{ files: [{ file_id: "file-output", filename: "chart.png" }] }] },
  });
  assert.match(codeCard.textContent!, /chart.png/);
});

test("errors and MCP labels render as text while opaque and image payloads stay out of DOM", () => {
  const card = createHostedToolCard({
    id: "mcp", name: "mcp_call", status: "failed",
    item: { server_label: "crm", name: "lookup", error: { message: "<script>failed</script>" }, output: "PRIVATE_PAYLOAD" },
  });
  assert.match(card.textContent!, /<script>failed<\/script>/);
  assert.equal(card.querySelector("script"), null);
  assert.doesNotMatch(card.outerHTML, /PRIVATE_PAYLOAD/);
  const success = createHostedToolCard({ id: "mcp", name: "mcp_call", status: "completed", item: { server_label: "crm", name: "lookup" } });
  assert.match(success.textContent!, /crm · lookup/);
  const image = createHostedToolCard({
    id: "image", name: "image_generation_call", status: "completed",
    item: { result: "HUGE_BASE64_PAYLOAD", encrypted_content: "OPAQUE_REASONING" },
  });
  assert.match(image.textContent!, /Image generated/);
  assert.doesNotMatch(image.outerHTML, /HUGE_BASE64_PAYLOAD|OPAQUE_REASONING/);
});

test("annotation parsing rejects unsafe URLs and retains native URL and file citations", () => {
  assert.deepEqual(references.responseReferencesFromAnnotations([
    { type: "url_citation", url: "https://example.com/", title: "Source" },
    { type: "url_citation", url_citation: { url: "http://example.org/", title: "Legacy source" } },
    { type: "file_citation", file_id: "file-1", filename: "notes.txt" },
    { url: "data:text/html,evil" }, { url: "https://secret:password@example.com" },
    { url: "not a url" }, null,
  ]), [
    { kind: "url", label: "Source", target: "https://example.com/" },
    { kind: "url", label: "Legacy source", target: "http://example.org/" },
    { kind: "file", label: "notes.txt", target: "file-1" },
  ]);
});

test("native generated image renders a bounded raster thumbnail without base64 in the DOM", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=";
  const card = createHostedToolCard({
    id: "image", name: "image_generation_call", status: "completed",
    item: { type: "image_generation_call", output_format: "png", result: png },
  });
  const image = card.querySelector("img");
  assert.ok(image);
  assert.equal(image.alt, "Generated image");
  const url = image.getAttribute("src")!;
  assert.match(url, /^blob:/);
  assert.equal(resolveObjectURL(url)?.type, "image/png");
  assert.equal(await resolveObjectURL(url)?.arrayBuffer().then((buffer) => buffer.byteLength), Buffer.from(png, "base64").length);
  assert.doesNotMatch(card.outerHTML, new RegExp(png.slice(0, 25)));
  image.dispatchEvent(new dom.window.Event("load"));
  assert.equal(resolveObjectURL(url), undefined, "object URL released after the image loads");
});

test("generated previews reject non-raster, mislabeled, malformed, and oversized payloads", async () => {
  const { HOSTED_IMAGE_MAX_BYTES } = await import("./HostedToolCardView.js");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=";
  for (const item of [
    { result: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString("base64"), output_format: "svg" },
    { result: png, output_format: "jpeg" },
    { result: "not base64%%" },
    { result: "A".repeat(4 * Math.ceil(HOSTED_IMAGE_MAX_BYTES / 3) + 4) },
  ]) {
    const card = createHostedToolCard({ id: "image", name: "image_generation_call", status: "completed", item });
    assert.equal(card.querySelector("img"), null);
    assert.match(card.textContent!, /Image preview unavailable/);
    assert.ok(card.outerHTML.length < 1500);
  }
});

test("MCP operation names retain their hosted activity identity", () => {
  const card = createHostedToolCard({ id: "mcp", name: "lookup", status: "completed", item: { type: "mcp_call", name: "lookup", server_label: "crm" } });
  assert.match(card.textContent!, /MCP toolCompletedcrm · lookup/);
});

test("file save avoids duplicate clicks while downloading and shows failures without a retry loop", async () => {
  let resolve!: (result: { ok: boolean; error?: string }) => void;
  let calls = 0;
  window.jellybot = { downloadResponseFile: () => {
    calls += 1;
    return new Promise((done) => { resolve = done; });
  } } as unknown as NonNullable<Window["jellybot"]>;
  const container = references.createResponseReferences([
    { kind: "file", label: "report.csv", target: "file-report", containerId: "cntr-report" },
  ], { sessionId: "session", messageId: "message" })!;
  const button = container.querySelector<HTMLButtonElement>("button")!;
  button.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  button.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.equal(calls, 1);
  assert.equal(button.disabled, true);
  assert.equal(container.querySelector('[role="status"]')?.textContent, "Saving…");
  resolve({ ok: false, error: "File expired" });
  await Promise.resolve();
  assert.equal(button.disabled, false);
  assert.equal(container.querySelector('[role="status"]')?.textContent, "File expired");
  assert.equal(calls, 1);
});

test("code output save actions require the native parent container and reject conflicting child containers", () => {
  window.jellybot = { downloadResponseFile: async () => ({ ok: true }) } as unknown as NonNullable<Window["jellybot"]>;
  const card = createHostedToolCard({
    id: "code", name: "code_interpreter_call", status: "completed", referenceContext: { sessionId: "session", messageId: "message" },
    item: { container_id: "cntr-code", outputs: [
      { file_id: "cfile-direct", filename: "direct.csv" },
      { files: [{ file_id: "cfile-nested", filename: "nested.png" }] },
      { file_id: "cfile-wrong", container_id: "cntr-other" },
      { files: [{ file_id: "cfile-wrong-child", container_id: "cntr-other" }] },
    ] },
  });
  assert.equal(card.querySelectorAll("button.response-reference-download").length, 2);
  assert.doesNotMatch(card.textContent!, /cfile-wrong/);
  const unbound = createHostedToolCard({
    id: "unbound", name: "code_interpreter_call", status: "completed", referenceContext: { sessionId: "session", messageId: "message" },
    item: { outputs: [{ file_id: "cfile-output" }] },
  });
  assert.equal(unbound.querySelector("button.response-reference-download"), null);
});
