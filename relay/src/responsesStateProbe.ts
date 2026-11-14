/**
 * Server-side probe: does this gateway truly retain Responses API
 * conversation state (`store: true` + `previous_response_id` follow-ups)?
 *
 * Two-step semantic verification — a gateway that merely accepts
 * `store: true` but drops the stored response would silently lose context.
 * The follow-up must repeat a random token that exists only in the first
 * request; HTTP 200 alone is not evidence. A best-effort DELETE removes the
 * stored probe response afterwards; cleanup failures never flip the verdict.
 *
 * Shares the /models probe's SSRF posture (see modelProbe.ts), redirect
 * refusal, per-attempt timeout and overall deadline. The API key stays in
 * the Authorization header and never appears in a reason or log line.
 */
import { isLocalLlmBaseUrl, probeTargetBlocked } from "./modelProbe.js";
import { randomBytes } from "node:crypto";

const PROBE_USER_AGENT = "JellyBotRelay/state-probe";
const PER_ATTEMPT_TIMEOUT_MS = 8_000;
/** Two POST turns plus a best-effort DELETE. */
const DEFAULT_DEADLINE_MS = 24_000;
/** Leave enough room for reasoning models to produce the short probe answer. */
const MAX_OUTPUT_TOKENS = 256;
const ENDPOINT_SUFFIX = /\/(?:chat\/completions|responses)\/*$/i;
const PROBE_FUNCTION_TOOL = {
  type: "function",
  name: "jellybot_state_probe_noop",
  description: "Probe-only no-op. Do not call unless explicitly requested.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  strict: false,
} as const;

export type ProbeResponsesStateResult =
  | { ok: true; supported: boolean }
  | {
      ok: false;
      /**
       * "invalid_url" | "missing_model" | "missing_key" | "blocked_target" |
       * "network" | "bad_payload" | `http_<status>`
       */
      reason: string;
    };

export type ProbeResponsesStateOptions = {
  /** Overall budget for the whole probe. */
  deadlineMs?: number;
  /** Injectable for tests; defaults to `node:dns/promises`.lookup. */
  resolveAddresses?: (host: string) => Promise<string[]>;
};

function splitUrl(value: string): { path: string; suffix: string } {
  const at = value.search(/[?#]/);
  return at < 0 ? { path: value, suffix: "" }
    : { path: value.slice(0, at), suffix: value.slice(at) };
}

/** Mirror of the desktop stripModelEndpoint + /responses join; queries survive. */
function responsesEndpointUrl(baseUrl: string, rawEndpoint: boolean): string | null {
  const value = baseUrl.trim();
  if (!value || !/^https?:\/\//i.test(value)) return null;
  if (rawEndpoint) return value;
  const { path, suffix } = splitUrl(value);
  return `${path.replace(ENDPOINT_SUFFIX, "").replace(/\/+$/, "")}/responses${suffix}`;
}

/** Insert a path suffix before any query/hash, never after it. */
function withPathSuffix(url: string, suffix: string): string {
  const at = url.search(/[?#]/);
  return at < 0 ? url + suffix : url.slice(0, at) + suffix + url.slice(at);
}

async function postResponses(
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ status: number; text: string } | { error: true }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "Content-Type": "application/json",
        "User-Agent": PROBE_USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
    const text = await response.text().catch(() => "");
    return { status: response.status, text };
  } catch {
    return { error: true as const };
  }
}

async function deleteResponse(url: string, apiKey: string, timeoutMs: number): Promise<void> {
  try {
    await fetch(url, {
      method: "DELETE",
      redirect: "manual",
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "User-Agent": PROBE_USER_AGENT,
      },
      signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
    });
  } catch {
    // Cleanup is best-effort by design.
  }
}

type ProbeResponsePayload = {
  id?: string;
  store?: boolean;
  previousResponseId?: string | null;
  outputText: string;
};

function parseResponsePayload(text: string): ProbeResponsePayload | undefined {
  try {
    const data = JSON.parse(text) as {
      id?: unknown;
      store?: unknown;
      previous_response_id?: unknown;
      output?: unknown;
    };
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
    const outputText = (Array.isArray(data.output) ? data.output : [])
      .filter((item): item is { type?: unknown; content?: unknown } => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      .filter((item) => item.type === "message")
      .flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .filter((part): part is { text?: unknown } => Boolean(part) && typeof part === "object" && !Array.isArray(part))
      .map((part) => typeof part.text === "string" ? part.text : "")
      .join("");
    return {
      ...(typeof data.id === "string" && data.id.trim() ? { id: data.id.trim() } : {}),
      ...(typeof data.store === "boolean" ? { store: data.store } : {}),
      ...(typeof data.previous_response_id === "string" || data.previous_response_id === null
        ? { previousResponseId: data.previous_response_id } : {}),
      outputText,
    };
  } catch {
    return undefined;
  }
}

/**
 * Probe whether an OpenAI-compatible gateway retains Responses conversation
 * state. Verdicts: `supported` (the second turn proves memory of a random
 * token), `!supported` (explicit stateless behavior or an unprovable token
 * answer), or a failure reason for anything the gateway never let us test
 * (auth, quota, 5xx, network).
 */
export async function probeResponsesState(
  input: {
    baseUrl: string;
    apiKey?: string;
    modelId: string;
    rawEndpoint?: boolean;
    responsesTools?: Array<Record<string, unknown>>;
  },
  options?: ProbeResponsesStateOptions,
): Promise<ProbeResponsesStateResult> {
  const baseUrl = (input.baseUrl ?? "").trim();
  const apiKey = (input.apiKey ?? "").trim();
  const modelId = (input.modelId ?? "").trim();
  if (!baseUrl) return { ok: false, reason: "invalid_url" };
  if (!modelId) return { ok: false, reason: "missing_model" };
  if (!apiKey && !isLocalLlmBaseUrl(baseUrl)) return { ok: false, reason: "missing_key" };

  const endpoint = responsesEndpointUrl(baseUrl, input.rawEndpoint === true);
  if (!endpoint) return { ok: false, reason: "invalid_url" };
  if (await probeTargetBlocked(endpoint, options?.resolveAddresses)) {
    return { ok: false, reason: "blocked_target" };
  }

  const deadlineMs = options?.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const startedAt = Date.now();
  const budget = () => deadlineMs - (Date.now() - startedAt);

  const token = `jellybot-state-${randomBytes(6).toString("hex")}`;
  // Match the real agent shape: local functions plus the provider's hosted
  // tools. GLM, for example, retains plain/function calls but currently drops
  // responses created while hosted web_search is declared.
  const tools = [PROBE_FUNCTION_TOOL, ...(input.responsesTools ?? [])];

  // Step 1 — create a stored response with a secret only this probe knows.
  const create = await postResponses(endpoint, apiKey, {
    model: modelId,
    input: `Remember this exact token: ${token}. Reply only OK.`,
    store: true,
    tools,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    stream: false,
  }, Math.min(PER_ATTEMPT_TIMEOUT_MS, budget()));
  if ("error" in create) return { ok: false, reason: "network" };
  if (create.status >= 300 && create.status < 400) return { ok: false, reason: "blocked_target" };
  if (create.status === 404 || create.status === 405) {
    // No Responses route at all — chat-only gateway.
    return { ok: true, supported: false };
  }
  if (create.status === 400 && /store/i.test(create.text)) {
    // Explicit parameter rejection, e.g. "Unknown parameter: 'store'".
    return { ok: true, supported: false };
  }
  if (create.status !== 200) return { ok: false, reason: `http_${create.status}` };
  const createdPayload = parseResponsePayload(create.text);
  const responseId = createdPayload?.id;
  if (!responseId) return { ok: false, reason: "bad_payload" };
  // DeepSeek documents this silent-ignore behavior. The desktop also treats
  // store:false as not reusable, so a second request would add no evidence.
  if (createdPayload.store === false) return { ok: true, supported: false };

  // Step 2 — the answer must contain the token, not merely return HTTP 200.
  const followUp = await postResponses(endpoint, apiKey, {
    model: modelId,
    previous_response_id: responseId,
    input: "What exact token did I ask you to remember? Reply with the token only.",
    store: true,
    tools,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    stream: false,
  }, Math.min(PER_ATTEMPT_TIMEOUT_MS, budget()));
  if ("error" in followUp) return { ok: false, reason: "network" };
  let supported: boolean;
  if (followUp.status === 200) {
    const payload = parseResponsePayload(followUp.text);
    if (!payload) return { ok: false, reason: "bad_payload" };
    supported = payload.previousResponseId !== null && payload.outputText.includes(token);
  }
  else if (followUp.status === 404) supported = false;
  else if (followUp.status === 400 &&
    /previous_response_id|response[^"']*not found|no (such )?response/i.test(followUp.text)) {
    // The gateway took the store but dropped it — the silent-data-loss mode.
    supported = false;
  } else {
    return { ok: false, reason: `http_${followUp.status}` };
  }

  // Best-effort cleanup: delete the stored probe response when deletable.
  await deleteResponse(
    withPathSuffix(endpoint, `/${encodeURIComponent(responseId)}`),
    apiKey,
    Math.min(4_000, Math.max(1_000, budget())),
  );
  return { ok: true, supported };
}
