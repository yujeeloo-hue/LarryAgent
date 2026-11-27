import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  askVcsCredentials,
  buildSvnAuthArgs,
  isVcsAuthFailure,
} from "../vcs/vcsAuth.js";
import { listSvnConflicts, type SvnConflictEntry } from "./conflicts.js";
import { execSvn } from "./execSvn.js";
import {
  isSvnUpdateReceivedLetter,
  parseSvnUpdateLogLine,
  parseSvnUpdateRevisionLine,
  type SvnUpdateActionLetter,
} from "./updateLog.js";

export type SvnUpdateEvent =
  | { type: "start"; fromRevision: string | null }
  | { type: "reset" }
  | { type: "line"; letter: SvnUpdateActionLetter; path: string; bytes: number }
  | { type: "progress"; paths: number; bytes: number; elapsedMs: number }
  | { type: "checking" }
  | {
      type: "done";
      revision: string | null;
      alreadyCurrent: boolean;
      paths: number;
      bytes: number;
      conflicts: SvnConflictEntry[];
      /** `svn status` failed, so the conflict list could not be checked. */
      conflictError?: string;
    }
  | { type: "stopped"; fromRevision: string | null; paths: number; bytes: number }
  | { type: "error"; message: string };

export type SvnUpdateHandle = {
  /** Ctrl-C equivalent: kills the child, the working copy stays consistent. */
  cancel: () => void;
  finished: Promise<void>;
};

const PROGRESS_THROTTLE_MS = 120;
const OUTPUT_TAIL_CHARS = 16 * 1024;

function lastLines(output: string, count = 4): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-count)
    .join(" · ");
}

async function currentRevision(root: string): Promise<string | null> {
  try {
    const { stdout } = await execSvn(root, ["info", "--show-item", "revision"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function startSvnUpdate(input: {
  root: string;
  paths: string[];
  onEvent: (event: SvnUpdateEvent) => void;
}): SvnUpdateHandle {
  const root = resolve(input.root);
  const targets = input.paths.filter((path) => path.trim().length > 0);
  const commandPaths = targets.length > 0 ? targets : ["."];
  const emit = input.onEvent;
  const startedAt = Date.now();

  let child: ChildProcessWithoutNullStreams | null = null;
  let cancelled = false;
  let revision: string | null = null;
  let alreadyCurrent = false;
  let pathCount = 0;
  let byteCount = 0;
  let lastProgressAt = 0;
  let chain: Promise<void> = Promise.resolve();

  const statBytes = async (relativePath: string): Promise<number> => {
    try {
      const info = await stat(join(root, relativePath));
      return info.isFile() ? info.size : 0;
    } catch {
      return 0;
    }
  };

  const emitProgress = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
    lastProgressAt = now;
    emit({
      type: "progress",
      paths: pathCount,
      bytes: byteCount,
      elapsedMs: now - startedAt,
    });
  };

  const handleLine = (raw: string): void => {
    const revisionLine = parseSvnUpdateRevisionLine(raw);
    if (revisionLine) {
      revision = revisionLine.revision;
      alreadyCurrent = revisionLine.alreadyCurrent;
      return;
    }
    const entry = parseSvnUpdateLogLine(raw);
    if (!entry) return;
    pathCount += 1;
    // Sizes come from disk so the panel can show "N paths · X MB" without
    // guessing (svn only prints byte progress on a TTY).
    chain = chain.then(async () => {
      const bytes = isSvnUpdateReceivedLetter(entry.letter)
        ? await statBytes(entry.path)
        : 0;
      byteCount += bytes;
      emit({ type: "line", letter: entry.letter, path: entry.path, bytes });
      emitProgress(false);
    });
  };

  const spawnOnce = (authArgs: string[]): Promise<{ code: number; output: string }> =>
    new Promise<{ code: number; output: string }>((resolvePromise) => {
      let settled = false;
      const settle = (code: number, output: string): void => {
        if (settled) return;
        settled = true;
        resolvePromise({ code, output });
      };
      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(
          "svn",
          [...authArgs, "--non-interactive", "update", "--", ...commandPaths],
          { cwd: root, windowsHide: true },
        );
      } catch (err) {
        settle(-1, err instanceof Error ? err.message : String(err));
        return;
      }
      child = proc;
      let buffer = "";
      let output = "";
      const onChunk = (chunk: string): void => {
        buffer += chunk;
        output += chunk;
        if (output.length > OUTPUT_TAIL_CHARS) {
          output = output.slice(-OUTPUT_TAIL_CHARS);
        }
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      };
      proc.stdout.setEncoding("utf8");
      proc.stderr.setEncoding("utf8");
      proc.stdout.on("data", onChunk);
      proc.stderr.on("data", onChunk);
      proc.on("error", (err) => {
        child = null;
        settle(-1, `svn could not start — ${err.message}`);
      });
      proc.on("close", (code) => {
        child = null;
        if (buffer.trim()) handleLine(buffer);
        settle(code ?? -1, output);
      });
    });

  const run = async (): Promise<void> => {
    const fromRevision = await currentRevision(root);
    if (cancelled) {
      emit({ type: "stopped", fromRevision, paths: pathCount, bytes: byteCount });
      return;
    }
    emit({ type: "start", fromRevision });

    let authArgs: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await spawnOnce(authArgs);
      await chain;
      if (cancelled) {
        emit({ type: "stopped", fromRevision, paths: pathCount, bytes: byteCount });
        return;
      }
      if (outcome.code === 0) {
        emitProgress(true);
        emit({ type: "checking" });
        let conflicts: SvnConflictEntry[] = [];
        let conflictError: string | undefined;
        try {
          conflicts = await listSvnConflicts(root);
        } catch (err) {
          // The update itself is fine; say so instead of claiming "no conflicts".
          conflictError = err instanceof Error ? err.message : String(err);
        }
        emit({
          type: "done",
          revision,
          alreadyCurrent,
          paths: pathCount,
          bytes: byteCount,
          conflicts,
          ...(conflictError ? { conflictError } : {}),
        });
        return;
      }
      if (attempt === 0 && isVcsAuthFailure(outcome.output)) {
        const credentials = await askVcsCredentials({
          vcs: "svn",
          operation: "Update",
          context: root,
          detail: lastLines(outcome.output),
        }).catch(() => null);
        if (cancelled) {
          emit({ type: "stopped", fromRevision, paths: pathCount, bytes: byteCount });
          return;
        }
        if (credentials) {
          authArgs = buildSvnAuthArgs(credentials);
          pathCount = 0;
          byteCount = 0;
          revision = null;
          alreadyCurrent = false;
          emit({ type: "reset" });
          continue;
        }
      }
      emit({
        type: "error",
        message: lastLines(outcome.output) || "svn update failed",
      });
      return;
    }
  };

  return {
    cancel: () => {
      if (cancelled) return;
      cancelled = true;
      child?.kill();
    },
    finished: run().catch((err: unknown) => {
      emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }),
  };
}
