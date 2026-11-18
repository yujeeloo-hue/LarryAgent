import { isLocalLlmBaseUrl, probeTargetBlocked } from "./modelProbe.js";
import { randomBytes } from "node:crypto";

const PROBE_USER_AGENT = "JellyBotRelay/state-probe";
const PER_ATTEMPT_TIMEOUT_MS = 8_000;
const DEFAULT_DEADLINE_MS = 24_000;
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
      reason: string;
    };

export type ProbeResponsesStateOptions = {
  deadlineMs?: number;
  resolveAddresses?: (host: string) => Promise<string[]>;
};

function splitUrl(value: string): { path: string; suffix: string } {
  const at = value.search(/[?#]/);
  return at < 0 ? { path: value, suffix: "" }
    : { path: value.slice(0, at), suffix: value.slice(at) };
}

function responsesEndpointUrl(baseUrl: string, rawEndpoint: boolean): string | null {
  const value = baseUrl.trim();
  if (!value || !/^https?:\/\//i.test(value)) return null;
  if (rawEndpoint) return value;
  const { path, suffix } = splitUrl(value);
  return `${path.replace(ENDPOINT_SUFFIX, "").replace(/\/+$/, "")}/responses${suffix}`;
}

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
  const tools = [PROBE_FUNCTION_TOOL, ...(input.responsesTools ?? [])];

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
    return { ok: true, supported: false };
  }
  if (create.status === 400 && /store/i.test(create.text)) {
    return { ok: true, supported: false };
  }
  if (create.status !== 200) return { ok: false, reason: `http_${create.status}` };
  const createdPayload = parseResponsePayload(create.text);
  const responseId = createdPayload?.id;
  if (!responseId) return { ok: false, reason: "bad_payload" };
  if (createdPayload.store === false) return { ok: true, supported: false };

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
    supported = false;
  } else {
    return { ok: false, reason: `http_${followUp.status}` };
  }

  await deleteResponse(
    withPathSuffix(endpoint, `/${encodeURIComponent(responseId)}`),
    apiKey,
    Math.min(4_000, Math.max(1_000, budget())),
  );
  return { ok: true, supported };
}
