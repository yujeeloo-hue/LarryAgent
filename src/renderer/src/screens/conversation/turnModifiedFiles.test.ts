import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MessageLikeForModifiedFiles } from "./turnModifiedFiles.js";
import {
  collectTurnFiles,
  collectUrlsFromMessages,
  pathKey,
  splitMessagesIntoTurns,
} from "./turnModifiedFiles.js";
import { RETRY_CONTINUATION_PART_ID } from "../../../../session/types.js";

type Part = Record<string, unknown>;

function toolCallMessage(
  id: string,
  name: string,
  args: Record<string, unknown>,
): MessageLikeForModifiedFiles {
  return { role: "assistant", parts: [{ type: "tool_call", id, name, arguments: args }] };
}

function toolResultMessage(
  callId: string,
  content: Part[],
  returnCode = 0,
): MessageLikeForModifiedFiles {
  return {
    role: "tool",
    parts: [{ type: "tool_result", toolCallId: callId, returnCode, content }],
  };
}

function assistantText(text: string): MessageLikeForModifiedFiles {
  return { role: "assistant", parts: [{ type: "text", text }] };
}

const passThrough = async (paths: string[]) => paths;

describe("splitMessagesIntoTurns", () => {
  it("keeps a hidden retry continuation inside the open turn", () => {
    // Retry = "continue the task": the failed turn's prompt and the
    // continuation's output must form ONE visual turn (like a steer), not
    // a new user-less turn group.
    const turns = splitMessagesIntoTurns([
      { role: "user", parts: [{ type: "text", text: "fix login" }] },
      { role: "assistant", parts: [{ type: "text", text: "halfway" }] },
      {
        role: "user",
        parts: [
          {
            type: "text",
            text: "continue the task",
            id: RETRY_CONTINUATION_PART_ID,
          },
        ],
      },
      { role: "assistant", parts: [{ type: "text", text: "done" }] },
    ]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0]!.length, 4);
  });

  it("a plain user message still starts a new turn", () => {
    const turns = splitMessagesIntoTurns([
      { role: "user", parts: [{ type: "text", text: "one" }] },
      { role: "assistant", parts: [] },
      { role: "user", parts: [{ type: "text", text: "two" }] },
    ]);
    assert.equal(turns.length, 2);
  });
});

describe("collectTurnFiles dedup", () => {
  it("pathKey treats backslash and forward slash spellings as one file", async () => {
    // Windows: tool args arrive with backslashes, file:// attachment URIs
    // decode to forward slashes — they must collide in the same key set.
    assert.equal(pathKey("C:\\Users\\me\\My App\\Notes.md"), pathKey("C:/Users/me/My App/Notes.md"));
    assert.equal(pathKey("C:\\a\\b.txt"), pathKey("c:/a//b.txt"));
    assert.notEqual(pathKey("C:\\a\\b.txt"), pathKey("C:\\a\\c.txt"));
  });

  it("merges file:// attachment and plain args spellings of one file", async () => {
    const messages = [
      toolCallMessage("c1", "write_file", { path: "/Users/me/My App/Notes.md" }),
      toolResultMessage("c1", [
        {
          type: "attachment",
          uri: "file:///Users/me/My%20App/Notes.md",
          name: "Notes.md",
        },
      ]),
      toolCallMessage("c2", "edit_file", { path: "/Users/me/My App/Notes.md" }),
      toolResultMessage("c2", [{ type: "text", text: "OK" }]),
    ];
    const files = await collectTurnFiles(messages, passThrough);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.action, "edited");
  });

  it("drops a mention whose casing differs from the tool path", async () => {
    const messages = [
      toolCallMessage("c1", "write_file", { path: "/Users/me/report.md" }),
      toolResultMessage("c1", [
        { type: "text", text: "Wrote /Users/me/report.md (1 chars)" },
      ]),
      assistantText("See `/Users/me/REPORT.MD` for details."),
    ];
    const files = await collectTurnFiles(messages, passThrough);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.path, "/Users/me/report.md");
    assert.equal(files[0]!.action, "created");
  });

  it("dedupes mentions that differ only by case or double slashes", async () => {
    const messages = [
      assistantText(
        "Built `//Users/me/dist/app.dmg` and `/users/me/DIST/App.dmg` today.",
      ),
    ];
    const files = await collectTurnFiles(messages, passThrough);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.action, "mentioned");
  });

  it("keeps distinct files in first-seen order", async () => {
    const messages = [
      toolCallMessage("c1", "write_file", { path: "/Users/me/a.md" }),
      toolResultMessage("c1", [
        { type: "text", text: "Wrote /Users/me/a.md (1 chars)" },
      ]),
      toolCallMessage("c2", "write_file", { path: "/Users/me/b.md" }),
      toolResultMessage("c2", [
        { type: "text", text: "Wrote /Users/me/b.md (1 chars)" },
      ]),
      assistantText("Also produced `/Users/me/out/app-1.0.dmg`."),
    ];
    const files = await collectTurnFiles(messages, passThrough);
    assert.deepEqual(
      files.map((f) => f.path),
      ["/Users/me/a.md", "/Users/me/b.md", "/Users/me/out/app-1.0.dmg"],
    );
  });
});

describe("collectUrlsFromMessages sources", () => {
  it("collects markdown and bare URLs from the assistant reply text", () => {
    const urls = collectUrlsFromMessages([
      assistantText(
        "Docs: [spec](https://example.com/docs/a). Mirror at https://example.com/docs/b.",
      ),
    ]);
    assert.deepEqual(urls.map((u) => u.url), [
      "https://example.com/docs/a",
      "https://example.com/docs/b",
    ]);
  });

  it("ignores URLs inside reasoning parts", () => {
    const urls = collectUrlsFromMessages([
      {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "maybe check https://reason.example/x" },
          assistantText("Done.").parts[0] as Part,
        ],
      },
    ]);
    assert.deepEqual(urls, []);
  });

  it("ignores URLs inside tool results and tool call args", () => {
    const urls = collectUrlsFromMessages([
      toolCallMessage("c1", "run_shell", {
        command: "curl https://tool-arg.example/ping",
      }),
      toolResultMessage("c1", [
        { type: "text", text: "fetched https://tool-result.example/body" },
      ]),
      assistantText("Finished without links."),
    ]);
    assert.deepEqual(urls, []);
  });

  it("ignores URLs in the user prompt", () => {
    const urls = collectUrlsFromMessages([
      { role: "user", parts: [{ type: "text", text: "read https://user.example/paste" }] },
      assistantText("Summary ready."),
    ]);
    assert.deepEqual(urls, []);
  });

  it("terminates a bare URL at CJK punctuation instead of swallowing prose", () => {
    const urls = collectUrlsFromMessages([
      assistantText(
        "详见 https://example.com/foo，完整说明见 https://example.com/bar。就这样。",
      ),
    ]);
    assert.deepEqual(urls.map((u) => u.url), [
      "https://example.com/foo",
      "https://example.com/bar",
    ]);
  });

  it("stops at CJK quotes and strips full-width punctuation glued to URLs", () => {
    const urls = collectUrlsFromMessages([
      assistantText("看「https://example.com/a（详情）」或“https://example.com/b，”。"),
    ]);
    assert.deepEqual(urls.map((u) => u.url), [
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("does not let a bare URL eat a following markdown link", () => {
    const urls = collectUrlsFromMessages([
      assistantText(
        "见 https://example.com/readme。详见[文档](https://example.com/docs)。",
      ),
    ]);
    assert.deepEqual(urls.map((u) => u.url), [
      "https://example.com/readme",
      "https://example.com/docs",
    ]);
  });

  it("keeps balanced parens that are part of the URL, trims prose closers", () => {
    const urls = collectUrlsFromMessages([
      assistantText(
        "看 https://en.wikipedia.org/wiki/Punctuation_(linguistics)，另见 (see https://example.com/a)。",
      ),
    ]);
    assert.deepEqual(urls.map((u) => u.url), [
      "https://en.wikipedia.org/wiki/Punctuation_(linguistics)",
      "https://example.com/a",
    ]);
  });

  it("keeps query strings but not the prose after them", () => {
    const urls = collectUrlsFromMessages([
      assistantText("参数见 https://example.com?a=1&b=2，注意编码"),
    ]);
    assert.deepEqual(urls.map((u) => u.url), ["https://example.com?a=1&b=2"]);
  });

  it("rejects non-http schemes, bare domains, and email-like tokens", () => {
    const urls = collectUrlsFromMessages([
      assistantText(
        "ftp://example.com/x、www.example.com、example.com/a、a@b.com",
      ),
    ]);
    assert.deepEqual(urls, []);
  });

  it("skips URLs inside fenced code blocks but keeps inline-code citations", () => {
    const urls = collectUrlsFromMessages([
      assistantText(
        "图：\n\n```svg\n<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>\n```\n\n已打开 `http://127.0.0.1:8081/a.html`。",
      ),
    ]);
    assert.deepEqual(urls.map((u) => u.url), ["http://127.0.0.1:8081/a.html"]);
  });

  it("trims markdown emphasis glued after a URL", () => {
    const urls = collectUrlsFromMessages([
      assistantText("服务在 **http://127.0.0.1:8311/**（端口 8311）"),
    ]);
    assert.deepEqual(urls.map((u) => u.url), ["http://127.0.0.1:8311/"]);
  });

  it("rejects placeholder and dotless hosts", () => {
    const urls = collectUrlsFromMessages([
      assistantText(
        "模板 https://{WorkspaceId}.example.com/api 和内网 http://intranet/x",
      ),
    ]);
    assert.deepEqual(urls, []);
  });
});
