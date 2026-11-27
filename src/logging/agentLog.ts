import { join } from "node:path";
import { FileSink } from "./fileSink.js";
import type { LogLevel } from "./types.js";

export type AgentLogFields = Record<string, unknown>;

export type AgentLogRecord = {
  ts: string;
  level: LogLevel;
  event: string;
  [key: string]: unknown;
};

const MAX_STRING = 2_000;
const MAX_JSON = 4_000;

const FULL_REQUEST_INLINE_MAX = 512_000;

let sink: FileSink | null = null;
let configured = false;
let fullLlmRequestLog = false;

export function configureAgentLog(appDataRoot: string): void {
  sink = new FileSink(join(appDataRoot, "logs"));
  configured = true;
}

export function getAgentLogsDir(): string | null {
  return sink?.directory ?? null;
}

export function setFullLlmRequestLog(enabled: boolean): void {
  fullLlmRequestLog = enabled === true;
}

export function isFullLlmRequestLogEnabled(): boolean {
  return fullLlmRequestLog;
}

export function truncateForLog(
  value: string,
  max = MAX_STRING,
): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

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

export function newCompactArtifactRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export type CompactArtifactPhase = "input" | "output";

export function agentLogCompactArtifact(input: {
  sessionId: string;
  strategy: string;
  phase: CompactArtifactPhase;
  runId: string;
  coverMode?: string;
  meta?: AgentLogFields;
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
