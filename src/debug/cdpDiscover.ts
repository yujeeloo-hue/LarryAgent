/** Discover Chrome / Node inspector targets on a loopback port. */

const ANSI = /\u001B\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** Node / Electron prints this on stderr when `--inspect` is on. */
export function parseNodeInspectorWebSocketUrl(text: string): string | null {
  const match = stripAnsi(text).match(
    /Debugger listening on (ws:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\/\S+)/i,
  );
  return match?.[1] ?? null;
}

/** Stderr banners that are not failures (inspector / Vite chunk warnings). */
export function isBenignDebuggeeStderr(text: string): boolean {
  const clean = stripAnsi(text);
  if (/Debugger listening on ws:\/\//i.test(clean)) return true;
  if (/Debugger attached\.?/i.test(clean)) return true;
  if (/Waiting for the debugger to disconnect/i.test(clean)) return true;
  if (/DevTools listening on ws:\/\//i.test(clean)) return true;
  if (/For help, see: https:\/\/nodejs\.org/i.test(clean)) return true;
  if (/\[plugin vite:reporter\]/.test(clean)) return true;
  if (/^\s*\(!\)/.test(clean)) return true;
  return false;
}

export type CdpTargetInfo = {
  id: string;
  type?: string;
  title?: string;
  url?: string;
  description?: string;
  webSocketDebuggerUrl?: string;
};

export function isNodeCdpTarget(target: CdpTargetInfo): boolean {
  const type = (target.type ?? "").toLowerCase();
  if (type === "node" || type === "node_worker") return true;
  if (type === "page" || type === "webview" || type === "iframe") return false;
  const blob = `${target.description ?? ""} ${target.title ?? ""}`;
  return /\bnode(\.js)?\b/i.test(blob);
}

export function isPageCdpTarget(target: CdpTargetInfo): boolean {
  const type = (target.type ?? "").toLowerCase();
  if (type === "page" || type === "webview" || type === "iframe") return true;
  if (isNodeCdpTarget(target)) return false;
  return Boolean(target.webSocketDebuggerUrl) && Boolean(target.url);
}

export function pickNodeCdpTarget(list: CdpTargetInfo[]): CdpTargetInfo | null {
  return (
    list.find((target) => target.webSocketDebuggerUrl && isNodeCdpTarget(target)) ??
    list.find((target) => Boolean(target.webSocketDebuggerUrl)) ??
    null
  );
}

export function shouldAttachPage(target: CdpTargetInfo): boolean {
  if (!target.webSocketDebuggerUrl || !isPageCdpTarget(target)) return false;
  const url = target.url ?? "";
  if (url.startsWith("devtools://") || url.startsWith("chrome-extension://")) {
    return false;
  }
  return true;
}

export function cdpPageSessionLabel(
  target: CdpTargetInfo,
  prefix: "Renderer" | "Page" = "Renderer",
): string {
  const title = target.title?.trim() ?? "";
  if (title && title !== "about:blank" && !/^http/i.test(title) && title.length < 80) {
    return `${prefix} · ${title}`;
  }
  const url = target.url?.trim() ?? "";
  if (url) {
    try {
      const parsed = new URL(url);
      const leaf =
        parsed.pathname.split("/").filter(Boolean).pop() ??
        parsed.hostname ??
        "page";
      return `${prefix} · ${leaf.replace(/\.(html?|js)$/i, "")}`;
    } catch {
      return prefix;
    }
  }
  return prefix;
}

export function rendererSessionLabel(target: CdpTargetInfo): string {
  return cdpPageSessionLabel(target, "Renderer");
}

export function pageSessionLabel(target: CdpTargetInfo): string {
  return cdpPageSessionLabel(target, "Page");
}

export async function fetchCdpTargets(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<CdpTargetInfo[]> {
  const urls = [
    `http://127.0.0.1:${port}/json/list`,
    `http://127.0.0.1:${port}/json`,
  ];
  let last = "";
  for (const url of urls) {
    try {
      const res = await fetchImpl(url);
      if (!res.ok) {
        last = `${res.status} ${res.statusText}`;
        continue;
      }
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) continue;
      return body.filter(
        (item): item is CdpTargetInfo =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as CdpTargetInfo).id === "string",
      );
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`CDP list on port ${port} failed (${last || "no response"})`);
}

/** Node inspector websocket — `/json/list` on `port`, or a URL parsed from stderr. */
export async function waitForNodeInspector(input: {
  port: number;
  timeoutMs: number;
  discoveredUrl?: () => string | undefined;
  isCancelled?: () => boolean;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}): Promise<string> {
  const started = Date.now();
  const interval = input.intervalMs ?? 250;
  let lastErr = "";
  while (Date.now() - started < input.timeoutMs) {
    if (input.isCancelled?.()) throw new Error("Cancelled");
    const discovered = input.discoveredUrl?.();
    if (discovered) return discovered;
    try {
      const main = pickNodeCdpTarget(
        await fetchCdpTargets(input.port, input.fetchImpl),
      );
      if (main?.webSocketDebuggerUrl) return main.webSocketDebuggerUrl;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  if (input.isCancelled?.()) throw new Error("Cancelled");
  const discovered = input.discoveredUrl?.();
  if (discovered) return discovered;
  throw new Error(
    `Timed out waiting for Node inspector on 127.0.0.1:${input.port}${
      lastErr ? ` — ${lastErr}` : ""
    }`,
  );
}
