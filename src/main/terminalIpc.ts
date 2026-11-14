import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { ipcMain, type WebContents } from "electron";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 200_000;
const MARKER_PREFIX = "__JB_DONE_";

type PendingCommand = {
  runId: string;
  marker: string;
  timer: ReturnType<typeof setTimeout>;
  emittedChars: number;
  truncated: boolean;
  /** Accumulated stdout used to find the completion marker. */
  stdoutBuf: string;
};

type ShellSession = {
  child: ChildProcess;
  webContents: WebContents;
  cwd: string;
  pending: PendingCommand | null;
};

/** One persistent shell per renderer webContents. */
const sessions = new Map<number, ShellSession>();

function resolveCwd(cwd: unknown): string {
  if (typeof cwd === "string" && cwd.trim() && isAbsolute(cwd.trim())) {
    return cwd.trim();
  }
  return homedir();
}

function send(
  webContents: WebContents,
  channel: string,
  payload: unknown,
): void {
  if (webContents.isDestroyed()) return;
  webContents.send(channel, payload);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseMarker(
  buf: string,
  marker: string,
): { before: string; exitCode: number; cwd?: string; rest: string } | null {
  const idx = buf.indexOf(marker);
  if (idx < 0) return null;
  const after = buf.slice(idx + marker.length);
  const nl = after.indexOf("\n");
  const payload = (nl >= 0 ? after.slice(0, nl) : after).trim();
  // Format: "<exitCode>" or "<exitCode>:<cwd>"
  const colon = payload.indexOf(":");
  const codePart = colon >= 0 ? payload.slice(0, colon) : payload;
  const cwdPart = colon >= 0 ? payload.slice(colon + 1) : "";
  const exitCode = Number.parseInt(codePart, 10);
  return {
    before: buf.slice(0, idx),
    exitCode: Number.isFinite(exitCode) ? exitCode : 1,
    ...(cwdPart ? { cwd: cwdPart } : {}),
    rest: nl >= 0 ? after.slice(nl + 1) : "",
  };
}

function emitOutput(
  session: ShellSession,
  pending: PendingCommand,
  stream: "stdout" | "stderr",
  chunk: string,
): void {
  if (!chunk || pending.truncated) return;
  const remaining = MAX_OUTPUT_CHARS - pending.emittedChars;
  if (remaining <= 0) {
    pending.truncated = true;
    send(session.webContents, "terminal:output", {
      runId: pending.runId,
      stream: "stderr",
      text: "\n…(truncated)\n",
    });
    return;
  }
  const text =
    chunk.length > remaining
      ? `${chunk.slice(0, remaining)}\n…(truncated)\n`
      : chunk;
  if (chunk.length > remaining) pending.truncated = true;
  pending.emittedChars += text.length;
  send(session.webContents, "terminal:output", {
    runId: pending.runId,
    stream,
    text,
  });
}

function finishPending(
  session: ShellSession,
  exitCode: number,
  options?: { signal?: string; cwd?: string },
): void {
  const pending = session.pending;
  if (!pending) return;
  clearTimeout(pending.timer);
  session.pending = null;
  if (options?.cwd) {
    session.cwd = options.cwd;
  }
  send(session.webContents, "terminal:done", {
    runId: pending.runId,
    exitCode,
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.cwd ? { cwd: options.cwd } : {}),
  });
}

function destroySession(webContentsId: number): void {
  const session = sessions.get(webContentsId);
  if (!session) return;
  sessions.delete(webContentsId);
  if (session.pending) {
    clearTimeout(session.pending.timer);
    send(session.webContents, "terminal:done", {
      runId: session.pending.runId,
      exitCode: 1,
      signal: "SIGTERM",
    });
    session.pending = null;
  }
  try {
    session.child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

function ensureSession(
  webContents: WebContents,
  cwd: string,
): ShellSession {
  const id = webContents.id;
  const existing = sessions.get(id);
  if (existing && !existing.child.killed) {
    return existing;
  }
  if (existing) {
    sessions.delete(id);
  }

  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/zsh";
  const args = isWin ? [] : [];

  const child = spawn(shell, args, {
    cwd,
    env: {
      ...process.env,
      // Quiet interactive prompts for the piped session.
      PS1: "",
      PS2: "",
      PS3: "",
      PS4: "",
      PROMPT: "",
      RPROMPT: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
    // Prevent a console window flash on every session start (Windows).
    ...(isWin ? { windowsHide: true } : {}),
  });

  const session: ShellSession = {
    child,
    webContents,
    cwd,
    pending: null,
  };
  sessions.set(id, session);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  // Silence zsh prompt noise; keep a usable interactive-like session.
  if (!isWin) {
    child.stdin?.write(
      "unsetopt PROMPT_SP 2>/dev/null; PROMPT=''; PS1=''; PS2='';\n",
    );
  }

  child.stdout?.on("data", (chunk: string) => {
    const pending = session.pending;
    if (!pending) return;
    pending.stdoutBuf += chunk;
    const parsed = parseMarker(pending.stdoutBuf, pending.marker);
    if (!parsed) {
      // Hold back a short suffix so we never flash a partial marker.
      const hold = pending.marker.length + 8;
      if (pending.stdoutBuf.length > hold) {
        const emitLen = pending.stdoutBuf.length - hold;
        const visible = pending.stdoutBuf.slice(0, emitLen);
        pending.stdoutBuf = pending.stdoutBuf.slice(emitLen);
        emitOutput(session, pending, "stdout", visible);
      }
      return;
    }
    if (parsed.before) {
      emitOutput(session, pending, "stdout", parsed.before);
    }
    pending.stdoutBuf = parsed.rest;
    finishPending(session, parsed.exitCode, {
      ...(parsed.cwd ? { cwd: parsed.cwd } : {}),
    });
  });

  child.stderr?.on("data", (chunk: string) => {
    const pending = session.pending;
    if (!pending) return;
    emitOutput(session, pending, "stderr", chunk);
  });

  child.on("error", (err) => {
    if (session.pending) {
      emitOutput(session, session.pending, "stderr", `${err.message}\n`);
      finishPending(session, 1);
    }
    sessions.delete(id);
  });

  child.on("close", (code, signal) => {
    if (session.pending) {
      finishPending(session, code ?? (signal ? 1 : 0), {
        ...(signal ? { signal } : {}),
      });
    }
    sessions.delete(id);
  });

  webContents.once("destroyed", () => {
    destroySession(id);
  });

  return session;
}

function writeCommand(session: ShellSession, command: string, marker: string): void {
  const isWin = process.platform === "win32";
  if (isWin) {
    session.child.stdin?.write(`${command}\r\n`);
    session.child.stdin?.write(`echo ${marker}%errorlevel%\r\n`);
    return;
  }
  // Same shell (no subshell) so cd/exports persist. Then print marker + $? + cwd.
  session.child.stdin?.write(`${command}\n`);
  session.child.stdin?.write(
    `printf '%s%d:%s\\n' ${shellSingleQuote(marker)} $? "$PWD"\n`,
  );
}

/**
 * Dev Terminal IPC — persistent shell session with streamed stdout/stderr.
 * Not the agent run_shell tool path.
 */
export function registerTerminalIpc(): void {
  ipcMain.handle(
    "terminal:run",
    async (
      event,
      req: { command?: unknown; cwd?: unknown },
    ): Promise<{ runId: string }> => {
      const command =
        typeof req?.command === "string" ? req.command.trim() : "";
      if (!command) {
        throw new Error("command is required");
      }
      const cwd = resolveCwd(req?.cwd);
      const webContents = event.sender;
      const session = ensureSession(webContents, cwd);

      if (session.pending) {
        throw new Error("A command is already running in this terminal");
      }

      const runId = randomUUID();
      const marker = `${MARKER_PREFIX}${runId.replace(/-/g, "")}__`;

      const timer = setTimeout(() => {
        if (session.pending?.runId !== runId) return;
        emitOutput(
          session,
          session.pending,
          "stderr",
          `\nCommand timed out after ${DEFAULT_TIMEOUT_MS}ms\n`,
        );
        try {
          session.child.kill("SIGINT");
        } catch {
          // ignore
        }
        // Ask the shell to report status so we can resume the session.
        setTimeout(() => {
          if (session.pending?.runId !== runId) return;
          session.child.stdin?.write(
            `printf '%s%d:%s\\n' ${shellSingleQuote(marker)} 124 "$PWD"\n`,
          );
        }, 150);
      }, DEFAULT_TIMEOUT_MS);

      session.pending = {
        runId,
        marker,
        timer,
        emittedChars: 0,
        truncated: false,
        stdoutBuf: "",
      };

      writeCommand(session, command, marker);
      return { runId };
    },
  );

  ipcMain.handle(
    "terminal:cancel",
    async (
      event,
      req: { runId?: unknown },
    ): Promise<{ ok: boolean }> => {
      const runId = typeof req?.runId === "string" ? req.runId : "";
      const session = sessions.get(event.sender.id);
      if (!session || !runId || session.pending?.runId !== runId) {
        return { ok: false };
      }
      const marker = session.pending.marker;
      try {
        session.child.kill("SIGINT");
      } catch {
        // ignore
      }
      // Recover the shell prompt/state, then close out this run.
      setTimeout(() => {
        if (session.pending?.runId !== runId) return;
        session.child.stdin?.write(
          process.platform === "win32"
            ? `echo ${marker}130\r\n`
            : `printf '%s%d:%s\\n' ${shellSingleQuote(marker)} 130 "$PWD"\n`,
        );
      }, 120);
      return { ok: true };
    },
  );
}
