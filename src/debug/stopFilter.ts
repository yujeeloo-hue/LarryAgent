import type { DapStoppedEvent } from "./dapTypes.js";

const BENIGN_EXCEPTIONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "0x406d1388", label: "thread name" },
  { code: "0x40010006", label: "debug output" },
  { code: "0x4001000a", label: "debug output" },
];

export function benignDebuggeeStop(
  stopped: DapStoppedEvent,
): { code: string; label: string } | null {
  if (stopped.reason !== "exception") return null;
  const text = `${stopped.description ?? ""} ${stopped.text ?? ""}`.toLowerCase();
  return BENIGN_EXCEPTIONS.find((entry) => text.includes(entry.code)) ?? null;
}
