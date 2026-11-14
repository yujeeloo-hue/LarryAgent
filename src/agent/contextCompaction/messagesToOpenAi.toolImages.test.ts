import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Message, ToolResultContentPart } from "../../session/types.js";

const S3_URL = "https://bucket.s3.us-east-1.amazonaws.com/j/a.png";

function toolMessage(content: ToolResultContentPart[]): Message {
  return {
    id: "t1",
    role: "tool",
    toolCallId: "call_1",
    createdAt: 0,
    parts: [
      {
        type: "tool_result",
        toolCallId: "call_1",
        content,
        returnCode: 0,
      },
    ],
  };
}

const directContent: ToolResultContentPart[] = [
  {
    type: "text",
    text: '[Image "a.png" at absolute path "/tmp/a.png" attached in this tool result. Analyze the attached image directly.]',
  },
  {
    type: "attachment",
    kind: "image",
    uri: "/tmp/a.png",
    mimeType: "image/png",
    name: "a.png",
    s3: { url: S3_URL, key: "j/a.png" },
  },
];

describe("messagesToOpenAi toolRoleImages option", () => {
  it("toolRoleImages renders the tool content as [text, image_url] with the S3 URL", async () => {
    const { messagesToOpenAi } = await import("./messagesToOpenAi.js");
    const out = messagesToOpenAi([toolMessage(directContent)], {
      toolRoleImages: true,
    });
    const content = out[0]!.content;
    assert.ok(Array.isArray(content), "content should be a parts array");
    const textPart = content.find((p: { type: string }) => p.type === "text") as
      | { text: string }
      | undefined;
    assert.match(textPart?.text ?? "", /attached in this tool result/);
    // The promoted attachment must NOT also appear as its wire stub text.
    assert.ok(!JSON.stringify(textPart?.text).includes("read_image"));
    const imageUrlPart = content.find(
      (p: { type: string }) => p.type === "image_url",
    ) as { image_url: { url: string } } | undefined;
    assert.equal(imageUrlPart?.image_url.url, S3_URL);
  });

  it("without the flag the tool content stays a plain string (stub path)", async () => {
    const { messagesToOpenAi } = await import("./messagesToOpenAi.js");
    const out = messagesToOpenAi([toolMessage(directContent)]);
    const content = out[0]!.content;
    assert.equal(typeof content, "string");
    assert.ok(!(content as string).includes("image_url"));
  });

  it("aged iterations keep the string form even with the flag", async () => {
    const { messagesToOpenAi, AGED_TOOL_RESULT_STUB } = await import(
      "./messagesToOpenAi.js"
    );
    const longText = `${"x".repeat(500)} ${directContent[0]!.type === "text" ? (directContent[0] as { text: string }).text : ""}`;
    const out = messagesToOpenAi(
      [toolMessage([{ type: "text", text: longText }, directContent[1]!])],
      { toolRoleImages: true, ageToolResults: true },
    );
    const content = out[0]!.content;
    assert.equal(typeof content, "string");
    assert.equal(content, AGED_TOOL_RESULT_STUB);
  });

  it("attachments without an s3 url keep the string form", async () => {
    const { messagesToOpenAi } = await import("./messagesToOpenAi.js");
    const out = messagesToOpenAi(
      [
        toolMessage([
          { type: "text", text: "Displayed /tmp/b.png" },
          {
            type: "attachment",
            kind: "image",
            uri: "/tmp/b.png",
            mimeType: "image/png",
            name: "b.png",
          },
        ]),
      ],
      { toolRoleImages: true },
    );
    assert.equal(typeof out[0]!.content, "string");
  });

  it("SVG attachments never become image_url parts", async () => {
    const { messagesToOpenAi } = await import("./messagesToOpenAi.js");
    const out = messagesToOpenAi(
      [
        toolMessage([
          { type: "text", text: "shown" },
          {
            type: "attachment",
            kind: "image",
            uri: "/tmp/c.svg",
            mimeType: "image/svg+xml",
            name: "c.svg",
            s3: { url: "https://bucket.example/c.svg", key: "c.svg" },
          },
        ]),
      ],
      { toolRoleImages: true },
    );
    const content = out[0]!.content;
    assert.equal(typeof content, "string");
    assert.ok(!(content as string).includes("image_url"));
  });
});
