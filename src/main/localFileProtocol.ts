import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import { gateLocalFilePath, isDemoHtmlPath } from "./localFileGate.js";
import { withDemoEscapeBridge } from "../shared/demoEscapeBridge.js";

export const LOCAL_FILE_SCHEME = "jellybot-file";

/**
 * Resolves the workspace roots for the demo-HTML allow-list. Injected by the
 * main index so the gate reflects every registered workspace: a protocol
 * request carries no session, and the settings-level active workspace is only
 * the New Task default — a demo card in any other workspace's session would
 * 403. Unset or failing → only os.tmpdir() serves demo HTML.
 */
let demoWorkspaceRootsResolver: (() => Promise<readonly string[]>) | null = null;

export function setLocalFileDemoWorkspaceRootsResolver(
  resolver: () => Promise<readonly string[]>,
): void {
  demoWorkspaceRootsResolver = resolver;
}

/**
 * Must run before `app.ready` so Chromium treats the scheme as privileged.
 */
export function registerLocalFileSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_FILE_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        bypassCSP: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Serve local image / PDF / demo-HTML files to the renderer for thumbnails,
 * previews, and present_demo iframes. Demo HTML is additionally gated to the
 * registered workspace roots + os.tmpdir() (see localFileGate).
 * URL shape: jellybot-file://local/?path=<absolute-encoded-path>
 */
export function installLocalFileProtocolHandler(): void {
  protocol.handle(LOCAL_FILE_SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      const rawPath = url.searchParams.get("path");
      let workspaceRoots: readonly string[] = [];
      if (demoWorkspaceRootsResolver) {
        try {
          workspaceRoots = await demoWorkspaceRootsResolver();
        } catch {
          workspaceRoots = [];
        }
      }
      const gate = gateLocalFilePath(rawPath, [...workspaceRoots, tmpdir()]);
      if (!gate.allowed) {
        return new Response(gate.reason, { status: gate.status });
      }
      if (!existsSync(gate.filePath)) {
        return new Response("Not found", { status: 404 });
      }
      const response = await net.fetch(pathToFileURL(gate.filePath).href);
      if (url.searchParams.get("demo") !== "1" || !isDemoHtmlPath(gate.filePath) || !response.ok) return response;
      const html = withDemoEscapeBridge(await response.text());
      return new Response(html, {
        status: response.status,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  });
}
