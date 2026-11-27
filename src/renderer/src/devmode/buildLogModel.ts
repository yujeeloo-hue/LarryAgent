import type { ChunkKind, LineSink, LineTone, LiveLine } from "./chunkLog.js";

export type BuildLogEntry = {
  readonly id: number;
  readonly kind: ChunkKind | "divider";
  text: string;
  tone: LineTone | null;
  rev: number;
};

const MAX_LINES = 50_000;
const TRIM_BATCH = 5_000;

export class BuildLogModel implements LineSink {
  private entries: BuildLogEntry[] = [];
  private nextId = 1;
  private listener: (() => void) | null = null;

  onChange(listener: (() => void) | null): void {
    this.listener = listener;
  }

  get length(): number {
    return this.entries.length;
  }

  at(index: number): BuildLogEntry {
    return this.entries[index]!;
  }

  appendOutput(text: string, kind: ChunkKind = "stdout"): void {
    const lines = text.match(/[^\n]*\n|[^\n]+$/g);
    if (!lines) return;
    for (const line of lines) this.push(kind, line);
    this.changed();
  }

  appendEndLine(text: string, ok: boolean): void {
    this.appendOutput(`${text}\n`, ok ? "meta" : "stderr");
  }

  appendDivider(): void {
    this.push("divider", "");
    this.changed();
  }

  openLine(kind: ChunkKind): LiveLine {
    const entry = this.push(kind, "");
    this.changed();
    return {
      get text() {
        return entry.text;
      },
      set: (text, tone) => {
        if (text === entry.text && (tone === undefined || tone === entry.tone)) return;
        entry.text = text;
        if (tone !== undefined) entry.tone = tone;
        entry.rev++;
        this.changed();
      },
    };
  }

  clear(): void {
    if (!this.entries.length) return;
    this.entries = [];
    this.changed();
  }

  private push(kind: BuildLogEntry["kind"], text: string): BuildLogEntry {
    const entry: BuildLogEntry = { id: this.nextId++, kind, text, tone: null, rev: 0 };
    this.entries.push(entry);
    if (this.entries.length > MAX_LINES) {
      this.entries.splice(0, Math.max(TRIM_BATCH, this.entries.length - MAX_LINES));
    }
    return entry;
  }

  private changed(): void {
    this.listener?.();
  }
}
