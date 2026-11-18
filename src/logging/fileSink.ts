import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

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

  writeLine(line: string): void {
    this.writeNamedLine(`agent-${todayStamp()}.log`, line);
  }

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
