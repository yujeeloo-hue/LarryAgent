import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isBenignDebuggeeStderr,
  parseNodeInspectorWebSocketUrl,
  pickNodeCdpTarget,
  rendererSessionLabel,
  pageSessionLabel,
  shouldAttachPage,
  waitForNodeInspector,
} from "./cdpDiscover.js";

describe("cdpDiscover", () => {
  it("prefers a Node inspector target for the main session", () => {
    const node = pickNodeCdpTarget([
      {
        id: "page",
        type: "page",
        title: "index",
        url: "http://localhost:5173/",
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/page",
      },
      {
        id: "main",
        type: "node",
        title: "electron",
        webSocketDebuggerUrl: "ws://127.0.0.1:9229/main",
      },
    ]);
    assert.equal(node?.id, "main");
  });

  it("skips DevTools and extension pages", () => {
    assert.equal(
      shouldAttachPage({
        id: "d",
        type: "page",
        url: "devtools://devtools/bundled/inspector.html",
        webSocketDebuggerUrl: "ws://127.0.0.1/d",
      }),
      false,
    );
    assert.equal(
      shouldAttachPage({
        id: "p",
        type: "page",
        title: "JellyBot",
        url: "http://localhost:5173/index.html",
        webSocketDebuggerUrl: "ws://127.0.0.1/p",
      }),
      true,
    );
  });

  it("labels renderer sessions from title or URL leaf", () => {
    assert.equal(
      rendererSessionLabel({
        id: "1",
        title: "JellyBot",
        url: "http://localhost:5173/index.html",
      }),
      "Renderer · JellyBot",
    );
    assert.equal(
      pageSessionLabel({
        id: "2",
        title: "http://localhost:3000/",
        url: "http://localhost:3000/dashboard",
      }),
      "Page · dashboard",
    );
  });

  it("parses the Node inspector websocket from stderr, including ANSI", () => {
    const line =
      "\u001B[33mDebugger listening on ws://127.0.0.1:5858/eb48ae51-b08c-410d-97d1-bc586f35066f\u001B[39m";
    assert.equal(
      parseNodeInspectorWebSocketUrl(line),
      "ws://127.0.0.1:5858/eb48ae51-b08c-410d-97d1-bc586f35066f",
    );
    assert.equal(isBenignDebuggeeStderr(line), true);
    assert.equal(
      isBenignDebuggeeStderr(
        "DevTools listening on ws://127.0.0.1:64283/devtools/browser/abc",
      ),
      true,
    );
    assert.equal(isBenignDebuggeeStderr("Debugger attached."), true);
    assert.equal(
      isBenignDebuggeeStderr("Waiting for the debugger to disconnect..."),
      true,
    );
    assert.equal(isBenignDebuggeeStderr("Failed to load native addon"), false);
  });

  it("prefers a stderr inspector URL over a closed allocated port", async () => {
    const url = await waitForNodeInspector({
      port: 1,
      timeoutMs: 1_000,
      intervalMs: 50,
      discoveredUrl: () => "ws://127.0.0.1:5858/abc",
      fetchImpl: (async () => {
        throw new Error("connection refused");
      }) as typeof fetch,
    });
    assert.equal(url, "ws://127.0.0.1:5858/abc");
  });
});
