import type { LogBuffer } from "./logBuffer.js";
import type { LogEntry, LogLevel, LogSource } from "./types.js";

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

const LEVEL_BY_METHOD: Record<ConsoleMethod, LogLevel> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

function formatArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) {
    return arg.stack ?? `${arg.name}: ${arg.message}`;
  }
  try {
    return JSON.stringify(arg);
  } catch {
    try {
      return String(arg);
    } catch {
      return "[unprintable]";
    }
  }
}

function formatMessage(args: unknown[]): string {
  return args.map(formatArg).join(" ");
}

let seq = 0;

function nextId(): string {
  seq += 1;
  return `log-${Date.now()}-${seq}`;
}

/**
 * Wrap console methods so each call is also appended to `buffer`.
 * Returns a dispose function that restores the originals.
 *
 * Re-entrancy is suppressed: logging from `onEntry` (e.g. IPC broadcast that
 * itself console.errors) must not recurse into capture → onEntry → …
 */
export function installConsoleCapture(
  buffer: LogBuffer,
  source: LogSource,
  onEntry?: (entry: LogEntry) => void,
): () => void {
  const methods: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];
  const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
  let reentrant = false;

  for (const method of methods) {
    const original = console[method].bind(console) as (
      ...args: unknown[]
    ) => void;
    originals.set(method, original);

    console[method] = (...args: unknown[]) => {
      if (reentrant) {
        try {
          original(...args);
        } catch {
          // Native console may throw RangeError on circular inspect.
        }
        return;
      }
      reentrant = true;
      try {
        try {
          original(...args);
        } catch {
          // Avoid crashing the process on inspect stack overflows.
        }
        let message: string;
        try {
          message = formatMessage(args);
        } catch {
          message = "[log format failed]";
        }
        const entry: LogEntry = {
          id: nextId(),
          ts: Date.now(),
          level: LEVEL_BY_METHOD[method],
          source,
          message,
        };
        buffer.append(entry);
        onEntry?.(entry);
      } finally {
        reentrant = false;
      }
    };
  }

  return () => {
    for (const method of methods) {
      const original = originals.get(method);
      if (original) {
        console[method] = original;
      }
    }
  };
}
