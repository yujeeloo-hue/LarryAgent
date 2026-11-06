import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

function formatOffset(minutes: number): string {
  const sign = minutes <= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function formatLocalIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = date.getTimezoneOffset();
  const sign = offsetMin <= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${oh}:${om}`
  );
}

function formatLocalDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Default level: 0 — live local date/time for the host machine. */
export const getCurrentTimeDefinition: ToolDefinition = {
  name: "get_current_time",
  description:
    "Return the host local date, time, timezone, and UTC offset.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  defaultPermissionLevel: 0,
};

export const getCurrentTimeHandler: ToolHandler = async (_args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  try {
    const now = new Date();
    const timeZone =
      Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const utcOffset = formatOffset(now.getTimezoneOffset());
    const weekday = WEEKDAYS[now.getDay()] ?? "unknown";
    const lines = [
      `Local time: ${formatLocalIso(now)} (${weekday})`,
      `Local date: ${formatLocalDate(now)}`,
      `Timezone: ${timeZone} (${utcOffset})`,
      `Unix ms: ${now.getTime()}`,
    ];
    return textResult(lines.join("\n"), ToolReturnCode.Success);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to read current time.";
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
