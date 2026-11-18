import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolExecuteContext } from "../types.js";
import {
  createCaptureAppWindowHandler,
} from "./captureAppWindow.js";
import { parseWindowCaptureResponse } from "../macos/windowCapture.js";

function makeContext(workspacePath: string): ToolExecuteContext {
  return {
    workspacePath,
    fullPermissionsEnabled: true,
  };
}

describe("capture_app_window", () => {
  it("parses successful helper metadata", () => {
    const parsed = parseWindowCaptureResponse(
      JSON.stringify({
        ok: true,
        path: "/tmp/window.png",
        appName: "Safari",
        windowTitle: "Example",
        windowId: 42,
        width: 1600,
        height: 1000,
      }),
    );
    assert.deepEqual(parsed, {
      ok: true,
      path: "/tmp/window.png",
      appName: "Safari",
      windowTitle: "Example",
      windowId: 42,
      width: 1600,
      height: 1000,
    });
  });

  it("rejects incomplete helper responses", () => {
    assert.throws(
      () => parseWindowCaptureResponse('{"ok":true,"path":"/tmp/a.png"}'),
      /incomplete image metadata/,
    );
  });

  it(
    "returns a PNG attachment after capture",
    { skip: process.platform !== "darwin" },
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "window-capture-test-"));
      const output = join(workspace, "captures", "safari.png");
      try {
        const handler = createCaptureAppWindowHandler(async (input) => {
          await writeFile(input.outputPath, Buffer.from("fake-png"));
          return {
            ok: true,
            path: input.outputPath,
            appName: "Safari",
            windowTitle: "Example",
            windowId: 42,
            width: 1600,
            height: 1000,
          };
        });
        const result = await handler(
          { app_name: "Safari", output },
          makeContext(workspace),
        );

        assert.equal(result.returnCode, ToolReturnCode.Success);
        assert.equal(result.content[0]?.type, "text");
        assert.match(
          result.content[0]?.type === "text" ? result.content[0].text : "",
          /Captured Safari — Example/,
        );
        const attachment = result.content.find(
          (part) => part.type === "attachment",
        );
        assert.equal(attachment?.type, "attachment");
        if (attachment?.type === "attachment") {
          assert.equal(attachment.kind, "image");
          assert.equal(attachment.mimeType, "image/png");
          assert.match(attachment.uri, /safari\.png$/);
        }
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it(
    "maps Screen Recording denial to permission denied",
    { skip: process.platform !== "darwin" },
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "window-capture-test-"));
      try {
        const handler = createCaptureAppWindowHandler(async () => ({
          ok: false,
          errorCode: "permission_required",
          message: "Screen Recording permission is required.",
        }));
        const result = await handler(
          {
            app_name: "Safari",
            output: join(workspace, "safari.png"),
          },
          makeContext(workspace),
        );
        assert.equal(result.returnCode, ToolReturnCode.PermissionDenied);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it(
    "requires a PNG output path",
    { skip: process.platform !== "darwin" },
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "window-capture-test-"));
      try {
        const handler = createCaptureAppWindowHandler(async () => {
          throw new Error("capture should not run");
        });
        const result = await handler(
          {
            app_name: "Safari",
            output: join(workspace, "safari.jpg"),
          },
          makeContext(workspace),
        );
        assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
