import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Append-only daily log file writer.
 * Serializes writes so concurrent callers do not interleave lines.
 */
export class FileSink {
  private readonly logsDir: string;
  private queue: Promise<void> = Promise.resolve();
  private dirReady = false;

  constructor(logsDir: string) {
    this.logsDir = logsDir;
  }

  get directory(): string {
    return this.logsDir;
  }

  /** Enqueue a line into the daily agent log (without trailing newline). */
  writeLine(line: string): void {
    this.writeNamedLine(`agent-${todayStamp()}.log`, line);
  }

  /**
   * Append a line to a named file under the logs directory
   * (e.g. `llm-requests-2026-07-24.jsonl`).
   */
  writeNamedLine(fileName: string, line: string): void {
    this.queue = this.queue
      .then(async () => {
        await this.ensureDir();
        const path = join(this.logsDir, fileName);
        await appendFile(path, `${line}\n`, "utf8");
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[agent-log] failed to write: ${message}`);
      });
  }

  /**
   * Write a file relative to the logs directory (creates parent dirs).
   * Fire-and-forget; shares the same serialize queue as line writers.
   */
  writeRelativeFile(relativePath: string, contents: string): void {
    this.queue = this.queue
      .then(async () => {
        await this.ensureDir();
        const path = join(this.logsDir, relativePath);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, contents, "utf8");
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[agent-log] failed to write file: ${message}`);
      });
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    await mkdir(this.logsDir, { recursive: true });
    this.dirReady = true;
  }
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}
