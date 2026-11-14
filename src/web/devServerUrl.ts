import { stripAnsi } from "../debug/cdpDiscover.js";

const LOCAL_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|::1?|\[::1?\]|\[::\])$/i;

function tidyUrl(raw: string): string | null {
  const trimmed = stripAnsi(raw)
    .replace(/[),.;]+$/g, "")
    .trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

function withoutInspectorNoise(text: string): string {
  return text
    .replace(/Debugger listening on[^\n]*/gi, " ")
    .replace(/DevTools listening on[^\n]*/gi, " ")
    .replace(/\bws:\/\/[^\s]+/gi, " ");
}

/** Chrome cannot usefully load 0.0.0.0 / [::] — rewrite to loopback. */
export function toChromePageUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (
      url.hostname === "0.0.0.0" ||
      url.hostname === "::" ||
      url.hostname === "[::]" ||
      url.hostname === "::1" ||
      url.hostname === "[::1]"
    ) {
      url.hostname = "127.0.0.1";
    }
    return url.href;
  } catch {
    return raw;
  }
}

/**
 * Pull the first local HTTP origin from Vite / Next / webpack / Express banners.
 */
export function parseDevServerUrl(text: string): string | null {
  const clean = withoutInspectorNoise(stripAnsi(text));
  const labeled = clean.match(
    /\b(?:Local|Network|local|listening on|listening at|ready on|ready at|running at|running on|started at|serving at):\s*(https?:\/\/[^\s]+)/i,
  );
  if (labeled?.[1]) {
    const url = tidyUrl(labeled[1]);
    if (url) return url;
  }
  const phrase = clean.match(
    /\b(?:listening on|listening at|ready on|ready at|running at|running on|started at|serving(?: files)? at)\s+(https?:\/\/[^\s]+)/i,
  );
  if (phrase?.[1]) {
    const url = tidyUrl(phrase[1]);
    if (url) return url;
  }
  const loopback = clean.match(
    /\b(https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|\[::\])(?::\d+)?[^\s]*)/i,
  );
  if (loopback?.[1]) {
    const url = tidyUrl(loopback[1]);
    if (url) return url;
  }
  const hostPort = clean.match(
    /\b(?:listening|running|serving|started)(?:\s+on|\s+at)?\s+(?:port\s+)?(?:https?:\/\/)?(0\.0\.0\.0|localhost|127\.0\.0\.1|\[::1?\]|\[::\]):(\d{2,5})\b/i,
  );
  if (hostPort?.[1] && hostPort[2] && LOCAL_HOST.test(hostPort[1])) {
    return `http://127.0.0.1:${hostPort[2]}/`;
  }
  const portOnly = clean.match(
    /\blisten(?:ing)?(?:\s+on|\s+at)?(?:\s+port)?\s+(\d{2,5})\b/i,
  );
  if (portOnly?.[1]) return `http://127.0.0.1:${portOnly[1]}/`;
  return null;
}

/** Internal marker so `failFast` aborts are not swallowed by soft-catch callers. */
class FailFastError extends Error {}

/**
 * Port from a server crash line like
 * `Error: listen EADDRINUSE: address already in use 127.0.0.1:8888`.
 * Inspector-port fallbacks ("Starting inspector on … failed") are not a
 * server crash and are ignored.
 */
export function parseAddressInUsePort(text: string): number | null {
  const clean = stripAnsi(text);
  if (!/EADDRINUSE|address already in use/i.test(clean)) return null;
  if (/inspector/i.test(clean)) return null;
  const colon = clean.match(/:(\d{2,5})\s*$/);
  if (colon) return Number(colon[1]);
  const labeled = clean.match(/\bport:?\s*(\d{2,5})\b/i);
  return labeled ? Number(labeled[1]) : null;
}

function httpReadyInput(
  url: string,
  timeoutMs: number,
  source: {
    isCancelled?: () => boolean;
    failFast?: () => string | undefined;
    fetchImpl?: typeof fetch;
    intervalMs?: number;
  },
): {
  url: string;
  timeoutMs: number;
  isCancelled?: () => boolean;
  failFast?: () => string | undefined;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
} {
  const out: {
    url: string;
    timeoutMs: number;
    isCancelled?: () => boolean;
    failFast?: () => string | undefined;
    fetchImpl?: typeof fetch;
    intervalMs?: number;
  } = { url, timeoutMs };
  if (source.isCancelled) out.isCancelled = source.isCancelled;
  if (source.failFast) out.failFast = source.failFast;
  if (source.fetchImpl) out.fetchImpl = source.fetchImpl;
  if (source.intervalMs !== undefined) out.intervalMs = source.intervalMs;
  return out;
}

export async function waitForHttpReady(input: {
  url: string;
  timeoutMs: number;
  isCancelled?: () => boolean;
  failFast?: () => string | undefined;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}): Promise<void> {
  const started = Date.now();
  const interval = input.intervalMs ?? 250;
  const fetchImpl = input.fetchImpl ?? fetch;
  let lastErr = "";
  while (Date.now() - started < input.timeoutMs) {
    if (input.isCancelled?.()) throw new Error("Cancelled");
    const reason = input.failFast?.();
    if (reason) throw new FailFastError(reason);
    try {
      const res = await fetchImpl(input.url, {
        redirect: "follow",
        signal: AbortSignal.timeout(2_000),
      });
      void res;
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  if (input.isCancelled?.()) throw new Error("Cancelled");
  throw new Error(
    `Timed out waiting for ${input.url}${lastErr ? ` — ${lastErr}` : ""}`,
  );
}

async function firstProbedUrl(
  probeUrls:
    | (() => Array<string | undefined> | Promise<Array<string | undefined>>)
    | undefined,
): Promise<string | undefined> {
  if (!probeUrls) return undefined;
  const list = await probeUrls();
  for (const item of list) {
    const url = item?.trim();
    if (url) return url;
  }
  return undefined;
}

export async function waitForDevServerUrl(input: {
  timeoutMs: number;
  configuredUrl?: string;
  discoveredUrl?: () => string | undefined;
  /** Ports the debuggee is already listening on (no banner required). */
  probeUrls?: () => Array<string | undefined> | Promise<Array<string | undefined>>;
  isCancelled?: () => boolean;
  /** Abort the wait early (e.g. the server crashed: port already in use). */
  failFast?: () => string | undefined;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
}): Promise<string> {
  const configured = input.configuredUrl?.trim();
  if (configured) {
    try {
      await waitForHttpReady(httpReadyInput(configured, input.timeoutMs, input));
    } catch (err) {
      if (err instanceof FailFastError) throw err;
      /* still open Chrome — the page may come up a moment later */
    }
    return configured;
  }
  const started = Date.now();
  const interval = input.intervalMs ?? 250;
  const remaining = (): number => Math.max(1, input.timeoutMs - (Date.now() - started));
  while (Date.now() - started < input.timeoutMs) {
    if (input.isCancelled?.()) throw new Error("Cancelled");
    const reason = input.failFast?.();
    if (reason) throw new FailFastError(reason);
    const discovered = input.discoveredUrl?.()?.trim();
    const probed = discovered ? undefined : await firstProbedUrl(input.probeUrls);
    const candidate = discovered ?? probed;
    if (candidate) {
      try {
        await waitForHttpReady(
          httpReadyInput(candidate, Math.min(2_000, remaining()), input),
        );
      } catch {
        /* listen port / banner is enough — Chrome retries the load */
      }
      return candidate;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  if (input.isCancelled?.()) throw new Error("Cancelled");
  const reason = input.failFast?.();
  if (reason) throw new FailFastError(reason);
  const late = input.discoveredUrl?.()?.trim() ?? (await firstProbedUrl(input.probeUrls));
  if (late) return late;
  throw new Error(
    "Timed out waiting for a local HTTP URL — set web.url in .larry/debug.json",
  );
}
