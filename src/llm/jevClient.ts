import { agentLogInfo, agentLogWarn } from "../logging/agentLog.js";
import { withLlmUserAgent } from "./userAgent.js";

export const JEV_REQUEST_TIMEOUT_MS = 15_000;
const JEV_MAX_ATTEMPTS = 3;
const RETRY_AFTER_CAP_MS = 10_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504, 529]);

export type JevClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
};

export type JevChoiceQuestion = {
  type: "choice";
  instructions: string;
  criteria: Record<string, string | null>;
};

export type JevNoulQuestion = {
  type: "noul";
  instructions: string;
  criteria?: { true: string; false: string };
};

export type JevQuestion = JevChoiceQuestion | JevNoulQuestion;

export type JevChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};

export type JevNoulAnswer = { type: "noul"; noul: number };

export type JevAnswers<Q extends Record<string, JevQuestion>> = {
  [K in keyof Q]?: Q[K] extends JevChoiceQuestion ? JevChoiceAnswer : JevNoulAnswer;
};

export type JevResult<Q extends Record<string, JevQuestion>> = {
  model: string;
  answers: JevAnswers<Q>;
  elapsedMs: number;
  inputTokens?: number;
};

export type JevRequestOptions = {
  signal?: AbortSignal;
  purpose?: string;
  fetchImpl?: typeof fetch;
};

export class JevError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "JevError";
  }
}

export function jevEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (/\/systemone$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/systemone`;
  return `${base}/v1/systemone`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterMs(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.min(Math.max(0, at - Date.now()), RETRY_AFTER_CAP_MS);
}

function errorDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error && typeof parsed.error.message === "string") return parsed.error.message;
    if (typeof parsed.message === "string") return parsed.message;
    if (typeof parsed.detail === "string") return parsed.detail;
  } catch {
    return raw.slice(0, 200);
  }
  return "";
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseAnswer(question: JevQuestion, raw: unknown): JevChoiceAnswer | JevNoulAnswer | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const answer = raw as Record<string, unknown>;
  if (question.type === "noul") {
    const p = finite(answer.noul);
    return answer.type === "noul" && p !== null ? { type: "noul", noul: Math.min(1, Math.max(0, p)) } : undefined;
  }
  if (answer.type !== "choice" || typeof answer.choice !== "string" || !(answer.choice in question.criteria)) return undefined;
  const probabilities: Record<string, number> = {};
  const rawProbabilities = answer.probabilities && typeof answer.probabilities === "object"
    ? answer.probabilities as Record<string, unknown>
    : {};
  for (const key of Object.keys(question.criteria)) {
    const p = finite(rawProbabilities[key]);
    if (p !== null) probabilities[key] = p;
  }
  if (!(answer.choice in probabilities)) return undefined;
  return {
    type: "choice",
    choice: answer.choice,
    probabilities,
    confidence: finite(answer.confidence) ?? 0,
  };
}

export async function askJev<Q extends Record<string, JevQuestion>>(
  client: JevClientConfig,
  request: { state: unknown; questions: Q },
  options: JevRequestOptions = {},
): Promise<JevResult<Q>> {
  const doFetch = options.fetchImpl ?? fetch;
  const endpoint = jevEndpoint(client.baseUrl);
  const body = JSON.stringify({ model: client.model, state: request.state, questions: request.questions });
  const timeoutMs = client.timeoutMs ?? JEV_REQUEST_TIMEOUT_MS;
  const started = performance.now();
  let lastError: JevError | null = null;

  for (let attempt = 1; attempt <= JEV_MAX_ATTEMPTS; attempt += 1) {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await doFetch(endpoint, {
        method: "POST",
        headers: withLlmUserAgent({
          Authorization: `Bearer ${client.apiKey}`,
          "Content-Type": "application/json",
        }),
        body,
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      lastError = new JevError(timeout.aborted ? `Jev request timed out after ${timeoutMs} ms` : `Jev request failed: ${error instanceof Error ? error.message : String(error)}`);
      if (attempt < JEV_MAX_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1), options.signal);
      continue;
    }

    const raw = await response.text();
    if (!response.ok) {
      const detail = errorDetail(raw);
      lastError = new JevError(`Jev HTTP ${response.status}${detail ? `: ${detail}` : ""}`, response.status);
      if (RETRY_STATUSES.has(response.status) && attempt < JEV_MAX_ATTEMPTS) {
        await sleep(retryAfterMs(response) ?? 500 * 2 ** (attempt - 1), options.signal);
        continue;
      }
      break;
    }

    let parsed: { model?: unknown; answers?: Record<string, unknown>; usage?: { input_tokens?: unknown } };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      lastError = new JevError("Jev returned a response that is not JSON");
      break;
    }
    const answers: Record<string, JevChoiceAnswer | JevNoulAnswer> = {};
    for (const [key, question] of Object.entries(request.questions)) {
      const answer = parseAnswer(question, parsed.answers?.[key]);
      if (answer) answers[key] = answer;
    }
    const elapsedMs = Math.round(performance.now() - started);
    const inputTokens = finite(parsed.usage?.input_tokens) ?? undefined;
    agentLogInfo("jev.request", {
      purpose: options.purpose ?? "decision",
      model: typeof parsed.model === "string" ? parsed.model : client.model,
      questions: Object.keys(request.questions).length,
      answered: Object.keys(answers).length,
      elapsedMs,
      attempts: attempt,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
    });
    return {
      model: typeof parsed.model === "string" ? parsed.model : client.model,
      answers: answers as JevAnswers<Q>,
      elapsedMs,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
    };
  }

  const error = lastError ?? new JevError("Jev request failed");
  agentLogWarn("jev.request_failed", {
    purpose: options.purpose ?? "decision",
    model: client.model,
    message: error.message,
    ...(error.status !== undefined ? { status: error.status } : {}),
  });
  throw error;
}

export function choiceProbability(answer: JevChoiceAnswer | undefined): number {
  return answer ? answer.probabilities[answer.choice] ?? 0 : 0;
}
