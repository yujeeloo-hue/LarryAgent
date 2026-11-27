import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatAttachmentWireStub } from "./attachmentWireText.js";

describe("formatAttachmentWireStub", () => {
  it("points raster images at read_image", () => {
    const stub = formatAttachmentWireStub({
      kind: "image",
      uri: "/tmp/photo.png",
      name: "photo.png",
      mimeType: "image/png",
    });
    assert.match(stub, /read_image/);
    assert.ok(!stub.includes("read_file"));
  });

  it("points SVG attachments at read_file, never read_image", () => {
    const stub = formatAttachmentWireStub({
      kind: "image",
      uri: "/tmp/icon.svg",
      name: "icon.svg",
      mimeType: "image/svg+xml",
    });
    assert.match(stub, /read_file/);
    assert.match(stub, /XML markup/);
    assert.ok(!stub.includes("Call read_image"));
  });
});
