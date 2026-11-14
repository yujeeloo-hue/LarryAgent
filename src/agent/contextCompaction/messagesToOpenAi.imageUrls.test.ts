import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message, MessagePart } from "../../session/types.js";

function userMessage(parts: MessagePart[]): Message {
  return { id: "u1", role: "user", createdAt: 0, parts };
}

describe("messagesToOpenAi imageUrls option", () => {
  const parts: MessagePart[] = [
    { type: "text", text: "What is in this image?" },
    {
      type: "attachment",
      kind: "image",
      uri: "/tmp/photo.png",
      mimeType: "image/png",
      name: "photo.png",
      s3: { url: "https://bucket.s3.us-east-1.amazonaws.com/j/a.png", key: "j/a.png" },
    },
    {
      type: "attachment",
      kind: "file",
      uri: "/tmp/notes.txt",
      mimeType: "text/plain",
      name: "notes.txt",
    },
  ];

  it("plain path keeps the read_image stub (no image_url parts)", async () => {
    const { messagesToOpenAi } = await import("./messagesToOpenAi.js");
    const out = messagesToOpenAi([userMessage(parts)]);
    const content = out[0]!.content;
    assert.equal(typeof content, "string");
    assert.match(content as string, /read_image/);
    assert.ok(!(content as string).includes("image_url"));
  });

  it("imageUrls path emits multimodal content with the S3 URL", async () => {
    const { messagesToOpenAi } = await import("./messagesToOpenAi.js");
    const out = messagesToOpenAi([userMessage(parts)], { imageUrls: true });
    const content = out[0]!.content;
    assert.ok(Array.isArray(content), "content should be a parts array");
    const textPart = content.find(
      (p: { type: string }) => p.type === "text",
    ) as { text: string } | undefined;
    // Text chunk keeps the question + non-image stubs, and carries a path
    // hint for the image (pixels are image_url parts; tools need the path).
    assert.match(textPart?.text ?? "", /What is in this image\?/);
    assert.match(textPart?.text ?? "", /notes\.txt/);
    assert.match(textPart?.text ?? "", /\/tmp\/photo\.png/);
    assert.ok(!textPart?.text.includes("read_image"));
    const imageUrlPart = content.find(
      (p: { type: string }) => p.type === "image_url",
    ) as { image_url: { url: string } } | undefined;
    assert.equal(
      imageUrlPart?.image_url.url,
      "https://bucket.s3.us-east-1.amazonaws.com/j/a.png",
    );
  });

  it("imageUrls with no s3 url falls back to the string path", async () => {
    const { messagesToOpenAi } = await import("./messagesToOpenAi.js");
    const bareParts: MessagePart[] = [
      { type: "text", text: "hello" },
      {
        type: "attachment",
        kind: "image",
        uri: "/tmp/x.png",
        mimeType: "image/png",
        name: "x.png",
      },
    ];
    const out = messagesToOpenAi([userMessage(bareParts)], { imageUrls: true });
    assert.equal(typeof out[0]!.content, "string");
  });

  it("SVG attachments never become image_url parts even with an s3 url", async () => {
    const { messagesToOpenAi } = await import("./messagesToOpenAi.js");
    const svgParts: MessagePart[] = [
      { type: "text", text: "replace this icon" },
      {
        type: "attachment",
        kind: "image",
        uri: "/tmp/glm.svg",
        mimeType: "image/svg+xml",
        name: "glm.svg",
        s3: { url: "https://bucket.example/glm.svg", key: "glm.svg" },
      },
    ];
    const out = messagesToOpenAi([userMessage(svgParts)], { imageUrls: true });
    const content = out[0]!.content;
    assert.equal(typeof content, "string");
    assert.match(content as string, /read_file/);
    assert.ok(!(content as string).includes("image_url"));
    assert.ok(!(content as string).includes("Call read_image"));
  });
});
