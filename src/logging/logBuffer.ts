import type { LogEntry } from "./types.js";

const DEFAULT_CAP = 500;

/** Fixed-capacity ring buffer for diagnostic log entries. */
export class LogBuffer {
  private readonly entries: LogEntry[] = [];
  private readonly cap: number;

  constructor(cap = DEFAULT_CAP) {
    this.cap = Math.max(1, cap);
  }

  append(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.cap) {
      this.entries.splice(0, this.entries.length - this.cap);
    }
  }

  clear(): void {
    this.entries.length = 0;
  }

  snapshot(): LogEntry[] {
    return this.entries.slice();
  }
}
