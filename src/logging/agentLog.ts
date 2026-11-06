import { join } from "node:path";
import { FileSink } from "./fileSink.js";
import type { LogLevel } from "./types.js";

/** Structured fields for agent / LLM / tool diagnostics. */
export type AgentLogFields = Record<string, unknown>;

export type AgentLogRecord = {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
};

const MAX_STRING = 2_000;
const MAX_JSON = 4_000;

/** Above this size, full request bodies go to a sidecar file under logs/requests/. */
const FULL_REQUEST_INLINE_MAX = 512_000;

let sink: FileSink | null = null;
let configured = false;
/** Process-local: when true, LLM requests write untruncated bodies to disk. */
let fullLlmRequestLog = false;

/**
 * Enable automatic disk persistence under `{appDataRoot}/logs/agent-YYYY-MM-DD.log`.
 * Safe to call once at app startup. Until configured, logs still go to console.
 */
export function configureAgentLog(appDataRoot: string): void {
  sink = new FileSink(join(appDataRoot, "logs"));
  configured = true;
}

/** Absolute path to `{appDataRoot}/logs`, or null before configure. */
export function getAgentLogsDir(): string | null {
  return sink?.directory ?? null;
}

/** Toggle full LLM request body logging (Log drawer; process memory only). */
export function setFullLlmRequestLog(enabled: boolean): void {
  fullLlmRequestLog = enabled === true;
}

export function isFullLlmRequestLogEnabled(): boolean {
  return fullLlmRequestLog;
}

/** Truncate a string for log payloads (avoid flooding disk / drawer). */
export function truncateForLog(
  value: string,
  max = MAX_STRING,
): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

/** JSON-stringify with truncation; never throws. */
export function safeJsonForLog(value: unknown, max = MAX_JSON): string {
  try {
    const raw = JSON.stringify(value);
    if (raw === undefined) return String(value);
    return truncateForLog(raw, max);
  } catch {
    return truncateForLog(String(value), max);
  }
}

function sanitizeFields(fields: AgentLogFields | undefined): AgentLogFields {
  if (!fields) return {};
  const out: AgentLogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("apikey") ||
      lower.includes("api_key") ||
      lower === "authorization" ||
      lower === "password" ||
      lower === "token"
    ) {
      out[key] = "[redacted]";
      continue;
    }
    if (typeof value === "string") {
      out[key] = truncateForLog(value);
      continue;
    }
    if (value instanceof Error) {
      out[key] = truncateForLog(value.stack ?? `${value.name}: ${value.message}`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function writeConsole(level: LogLevel, event: string, fields: AgentLogFields): void {
  const prefix = `[agent] ${event}`;
  const payload =
    Object.keys(fields).length > 0 ? ` ${safeJsonForLog(fields)}` : "";
  const line = `${prefix}${payload}`;
  switch (level) {
    case "debug":
      console.debug(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "error":
      console.error(line);
      break;
    default:
      console.info(line);
  }
}

/**
 * Structured agent diagnostic log.
 * Always mirrors to console (Log Drawer). When configured, also appends JSONL to disk.
 */
export function agentLog(
  level: LogLevel,
  event: string,
  fields?: AgentLogFields,
): void {
  const sanitized = sanitizeFields(fields);
  const record: AgentLogRecord = {
    ts: new Date().toISOString(),
    level,
    event,
    ...sanitized,
  };

  writeConsole(level, event, sanitized);

  if (sink) {
    try {
      sink.writeLine(JSON.stringify(record));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[agent-log] serialize failed: ${message}`);
    }
  }
}

export const agentLogInfo = (
  event: string,
  fields?: AgentLogFields,
): void => agentLog("info", event, fields);

export const agentLogWarn = (
  event: string,
  fields?: AgentLogFields,
): void => agentLog("warn", event, fields);

export const agentLogError = (
  event: string,
  fields?: AgentLogFields,
): void => agentLog("error", event, fields);

function redactSensitiveKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveKeys);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (
        lower.includes("apikey") ||
        lower.includes("api_key") ||
        lower === "authorization" ||
        lower === "password" ||
        lower === "token"
      ) {
        out[key] = "[redacted]";
      } else {
        out[key] = redactSensitiveKeys(child);
      }
    }
    return out;
  }
  return value;
}

/**
 * Disk-only, untruncated log for full LLM request bodies.
 * Always written to a dedicated daily file:
 * `{logs}/llm-requests-YYYY-MM-DD.jsonl` (never mixed into agent-*.log).
 * Skips the console / Log drawer to avoid flooding the 500-entry buffer.
 * When the payload exceeds {@link FULL_REQUEST_INLINE_MAX}, messages/tools
 * go to `logs/requests/*.json` and the JSONL line keeps metadata + path.
 */
export function agentLogFullRequest(
  event: string,
  fields: AgentLogFields,
): void {
  if (!fullLlmRequestLog) return;

  const redacted = redactSensitiveKeys(fields) as AgentLogFields;
  const record: AgentLogRecord = {
    ts: new Date().toISOString(),
    level: "info",
    event,
    ...redacted,
  };

  if (!sink) {
    // Fall back to truncated console so smoke tests still see something.
    writeConsole("info", event, {
      note: "full request log (no disk sink)",
      messageCount: redacted.messageCount,
      toolDefCount: redacted.toolDefCount,
    });
    return;
  }

  try {
    let line = JSON.stringify(record);
    if (line.length > FULL_REQUEST_INLINE_MAX) {
      const body = {
        messages: redacted.messages,
        tools: redacted.tools,
      };
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const sessionPart =
        typeof redacted.sessionId === "string"
          ? redacted.sessionId.slice(0, 8)
          : "nosession";
      const roundPart =
        typeof redacted.iteration === "number" ? `i${redacted.iteration}` : "i0";
      const relativePath = `requests/${stamp}-${sessionPart}-${roundPart}.json`;
      sink.writeRelativeFile(relativePath, JSON.stringify(body, null, 2));
      const slim: AgentLogRecord = {
        ts: record.ts,
        level: "info",
        event,
        sessionId: redacted.sessionId,
        iteration: redacted.iteration,
        purpose: redacted.purpose,
        model: redacted.model,
        host: redacted.host,
        messageCount: redacted.messageCount,
        toolDefCount: redacted.toolDefCount,
        prefix: redacted.prefix,
        toolsHash: redacted.toolsHash,
        toolsNames: redacted.toolsNames,
        bodyFile: relativePath,
        bodyChars: line.length,
      };
      line = JSON.stringify(slim);
    }
    const date = new Date().toISOString().slice(0, 10);
    sink.writeNamedLine(`llm-requests-${date}.jsonl`, line);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent-log] full request serialize failed: ${message}`);
  }
}

/** Shared id pairing `input` / `output` files for one compaction pass. */
export function newCompactArtifactRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export type CompactArtifactPhase = "input" | "output";

/**
 * Always-on full compaction artifact logging (not gated by full LLM request toggle).
 *
 * Writes untruncated JSON to:
 * `{logs}/compactions/{runId}-{session8}-{phase}.json`
 *
 * And a slim pointer into the daily agent JSONL (`compact.artifact`) so the
 * Log drawer stays small while the sidecar keeps the raw request / result.
 */
export function agentLogCompactArtifact(input: {
  sessionId: string;
  strategy: string;
  phase: CompactArtifactPhase;
  runId: string;
  coverMode?: string;
  /** Small counters copied into the slim agent log line. */
  meta?: AgentLogFields;
  /** Full untruncated payload — sidecar only. */
  data: Record<string, unknown>;
}): string | null {
  const sessionPart =
    input.sessionId.length > 0 ? input.sessionId.slice(0, 8) : "nosession";
  const relativePath = `compactions/${input.runId}-${sessionPart}-${input.phase}.json`;
  const redactedData = redactSensitiveKeys(input.data) as Record<
    string,
    unknown
  >;
  const redactedMeta = input.meta
    ? (redactSensitiveKeys(input.meta) as AgentLogFields)
    : {};

  const fileBody = {
    ts: new Date().toISOString(),
    sessionId: input.sessionId,
    strategy: input.strategy,
    phase: input.phase,
    runId: input.runId,
    ...(input.coverMode ? { coverMode: input.coverMode } : {}),
    ...redactedMeta,
    ...redactedData,
  };

  let bodyChars = 0;
  try {
    const contents = JSON.stringify(fileBody, null, 2);
    bodyChars = contents.length;
    if (sink) {
      sink.writeRelativeFile(relativePath, contents);
    } else {
      writeConsole("info", "compact.artifact", {
        note: "compact artifact (no disk sink)",
        phase: input.phase,
        strategy: input.strategy,
        bodyChars,
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[agent-log] compact artifact serialize failed: ${message}`);
    return null;
  }

  // Slim pointer — strings in meta are still truncated by agentLog sanitize.
  agentLogInfo("compact.artifact", {
    sessionId: input.sessionId,
    strategy: input.strategy,
    phase: input.phase,
    runId: input.runId,
    ...(input.coverMode ? { coverMode: input.coverMode } : {}),
    artifactFile: relativePath,
    bodyChars,
    ...redactedMeta,
  });

  return relativePath;
}
