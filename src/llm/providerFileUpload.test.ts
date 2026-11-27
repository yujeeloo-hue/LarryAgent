import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { AttachmentDraft } from "../agent/ipcTypes.js";
import { uploadImageAttachmentsToProviderFiles } from "./providerFileUpload.js";

const tmpDirs: string[] = [];

after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function makeImageDraft(
  name: string,
  bytes: Buffer,
): Promise<AttachmentDraft> {
  const dir = await mkdtemp(join(tmpdir(), "jellybot-files-"));
  tmpDirs.push(dir);
  const path = join(dir, name);
  await writeFile(path, bytes);
  return {
    kind: "image",
    path,
    mimeType: "image/png",
  } as AttachmentDraft;
}

function okFetch(id: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ id, object: "file" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
}

describe("uploadImageAttachmentsToProviderFiles", () => {
  it("uploads images and references them as ms://<file-id>", async () => {
    const draft = await makeImageDraft("a.png", Buffer.from("png-bytes"));
    let seenUrl = "";
    const fetchFn = (async (url: string | URL) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ id: "file-abc" }), {
        status: 200,
      });
    }) as typeof fetch;
    const result = await uploadImageAttachmentsToProviderFiles({
      baseUrl: "https://api.moonshot.cn/v1/",
      apiKey: "sk-test",
      attachments: [draft],
      fetchFn,
    });
    assert.equal(seenUrl, "https://api.moonshot.cn/v1/files");
    assert.equal(result.uploaded, 1);
    assert.equal(result.failed, 0);
    assert.equal(draft.s3?.url, "ms://file-abc");
    assert.equal(draft.s3?.key, "file-abc");
  });

  it("degrades per-file on API errors without throwing", async () => {
    const draft = await makeImageDraft("b.png", Buffer.from("png-bytes"));
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({ error: { message: "bad purpose" } }),
        { status: 400 },
      )) as typeof fetch;
    const result = await uploadImageAttachmentsToProviderFiles({
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "sk-test",
      attachments: [draft],
      fetchFn,
    });
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 1);
    assert.equal(draft.s3, undefined);
  });

  it("skips non-image drafts and drafts already carrying s3", async () => {
    const image = await makeImageDraft("c.png", Buffer.from("png-bytes"));
    image.s3 = { url: "ms://existing", key: "existing" };
    const file = {
      kind: "file",
      path: "/tmp/whatever.txt",
    } as AttachmentDraft;
    const result = await uploadImageAttachmentsToProviderFiles({
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "sk-test",
      attachments: [image, file],
      fetchFn: okFetch("file-new"),
    });
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 0);
    assert.equal(image.s3.url, "ms://existing");
  });

  it("no-ops without a base URL", async () => {
    const draft = await makeImageDraft("d.png", Buffer.from("png-bytes"));
    const result = await uploadImageAttachmentsToProviderFiles({
      baseUrl: "  ",
      apiKey: "sk-test",
      attachments: [draft],
      fetchFn: okFetch("file-x"),
    });
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 0);
    assert.equal(draft.s3, undefined);
  });

  it("skips SVG drafts instead of uploading them as vision images", async () => {
    const svg = await makeImageDraft("icon.svg", Buffer.from("<svg></svg>"));
    svg.mimeType = "image/svg+xml";
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ id: "file-svg" }), { status: 200 });
    }) as typeof fetch;
    const result = await uploadImageAttachmentsToProviderFiles({
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "sk-test",
      attachments: [svg],
      fetchFn,
    });
    assert.equal(calls, 0);
    assert.equal(result.uploaded, 0);
    assert.equal(result.failed, 0);
    assert.equal(svg.s3, undefined);
  });
});
