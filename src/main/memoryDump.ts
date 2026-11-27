import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { writeHeapSnapshot } from "node:v8";

const HEAP_PROTOCOL = "1.3";

export type MemoryDumpFile = {
  role: "main" | "renderer";
  id: string;
  path: string;
  bytes: number;
};

export type MemoryDumpResult = {
  ok: boolean;
  canceled?: boolean;
  files: MemoryDumpFile[];
  errors: string[];
};

export type HeapMessageListener = (
  event: unknown,
  method: string,
  params: unknown,
) => void;

export type HeapDebugger = {
  isAttached: () => boolean;
  attach: (protocolVersion?: string) => void;
  detach: () => void;
  sendCommand: (
    method: string,
    commandParams?: Record<string, unknown>,
  ) => Promise<unknown>;
  on: (event: "message", listener: HeapMessageListener) => void;
  off: (event: "message", listener: HeapMessageListener) => void;
};

export type RendererHeapTarget = {
  id: number;
  title: string;
  debugger: HeapDebugger;
};

export function formatDumpStamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function withHeapSnapshotExtension(filePath: string): string {
  const ext = extname(filePath);
  if (!ext) return `${filePath}.heapsnapshot`;
  return filePath;
}

export function heapSnapshotSibling(filePath: string, suffix: string): string {
  const ext = extname(filePath);
  const stem = ext ? filePath.slice(0, -ext.length) : filePath;
  return `${stem}-${suffix}${ext || ".heapsnapshot"}`;
}

export function formatMemoryDumpLog(result: MemoryDumpResult): string {
  if (result.files.length === 0) {
    const detail = result.errors.join(" ");
    return detail
      ? `[memory] Heap snapshot failed. ${detail}`
      : "[memory] Heap snapshot failed.";
  }
  const parts = result.files.map(
    (file) => `${file.path} (${formatMegabytes(file.bytes)})`,
  );
  const skipped =
    result.errors.length > 0 ? ` ${result.errors.length} skipped.` : "";
  return `[memory] Saved heap snapshot ${parts.join(", ")}.${skipped}`;
}

export async function dumpMemoryGraphs(input: {
  filePath: string;
  renderers: RendererHeapTarget[];
  writeMainSnapshot?: (filePath: string) => void;
}): Promise<MemoryDumpResult> {
  const filePath = input.filePath;
  const files: MemoryDumpFile[] = [];
  const errors: string[] = [];
  await mkdir(dirname(filePath), { recursive: true });

  for (const target of input.renderers) {
    const rendererPath = heapSnapshotSibling(
      filePath,
      `renderer-${target.id}`,
    );
    try {
      const bytes = await captureRendererHeap(target, rendererPath);
      files.push({
        role: "renderer",
        id: `renderer-${target.id}`,
        path: rendererPath,
        bytes,
      });
    } catch (err) {
      errors.push(`${windowLabel(target)}: ${errorText(err)}`);
    }
  }

  try {
    (input.writeMainSnapshot ?? writeHeapSnapshot)(filePath);
    const info = await stat(filePath);
    if (info.size <= 0) throw new Error("Heap snapshot was empty.");
    files.push({
      role: "main",
      id: "main",
      path: filePath,
      bytes: info.size,
    });
  } catch (err) {
    await rm(filePath, { force: true });
    errors.push(`Main process: ${errorText(err)}`);
  }

  return { ok: files.length > 0, files, errors };
}

async function captureRendererHeap(
  target: RendererHeapTarget,
  filePath: string,
): Promise<number> {
  const dbg = target.debugger;
  let attachedByUs = false;
  let stream: WriteStream | undefined;
  let chain = Promise.resolve();
  let bytes = 0;
  let writeError: unknown;
  const onMessage: HeapMessageListener = (_event, method, params) => {
    if (method !== "HeapProfiler.addHeapSnapshotChunk") return;
    const chunk = chunkText(params);
    if (chunk === undefined || !stream) return;
    bytes += Buffer.byteLength(chunk);
    const current = stream;
    chain = chain
      .then(() => writeChunk(current, chunk))
      .catch((err: unknown) => {
        writeError ??= err;
      });
  };
  try {
    if (!dbg.isAttached()) {
      dbg.attach(HEAP_PROTOCOL);
      attachedByUs = true;
    }
    stream = createWriteStream(filePath);
    stream.on("error", (err: unknown) => {
      writeError ??= err;
    });
    dbg.on("message", onMessage);
    await dbg.sendCommand("HeapProfiler.enable");
    await dbg.sendCommand("HeapProfiler.takeHeapSnapshot", {
      reportProgress: false,
    });
    await chain;
    if (writeError) throw writeError;
    if (bytes <= 0) throw new Error("Heap snapshot was empty.");
    await finishStream(stream);
    stream = undefined;
    return bytes;
  } catch (err) {
    if (stream) await destroyStream(stream);
    await rm(filePath, { force: true });
    throw err;
  } finally {
    dbg.off("message", onMessage);
    if (attachedByUs) {
      try {
        await dbg.sendCommand("HeapProfiler.disable");
      } catch {
      }
      try {
        dbg.detach();
      } catch {
      }
    }
  }
}

function writeChunk(stream: WriteStream, chunk: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, "utf8", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function destroyStream(stream: WriteStream): Promise<void> {
  if (stream.closed) return Promise.resolve();
  return new Promise((resolve) => {
    stream.once("close", () => resolve());
    stream.destroy();
  });
}

function finishStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (err: Error) => {
      stream.off("finish", done);
      reject(err);
    };
    const done = () => {
      stream.off("error", fail);
      resolve();
    };
    stream.once("error", fail);
    stream.once("finish", done);
    stream.end();
  });
}

function chunkText(params: unknown): string | undefined {
  if (!params || typeof params !== "object" || !("chunk" in params)) return;
  const chunk = (params as { chunk?: unknown }).chunk;
  return typeof chunk === "string" ? chunk : undefined;
}

function windowLabel(target: RendererHeapTarget): string {
  const title = target.title.replace(/\s+/g, " ").trim().slice(0, 80);
  return title ? `Window ${target.id} (${title})` : `Window ${target.id}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 100) return `${Math.round(mb)} MB`;
  return `${mb.toFixed(1)} MB`;
}
