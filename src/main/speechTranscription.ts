import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app, ipcMain, systemPreferences, type WebContents } from "electron";

/**
 * File-level diagnostics for the speech pipeline. Packaged builds have no
 * stdout to read; this lands next to the user data so a failing take can be
 * traced end-to-end (gate → spawn → stdout events → stop result).
 */
export function speechDebugLog(message: string): void {
  try {
    const file = join(app.getPath("userData"), "speech-debug.log");
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Logging must never break the pipeline.
  }
}

/** How long speech:stop waits for the helper's `final` line before SIGTERM. */
const FINAL_TIMEOUT_MS = 2_500;
/** Escalation window after SIGTERM (helper exits gracefully) before SIGKILL. */
const KILL_TIMEOUT_MS = 800;
/** Cap on the one-shot TCC prompt ask; then fall back to a status poll. */
const PERMISSION_ASK_TIMEOUT_MS = 90_000;
/** Cap a single stdout line; events are tiny, this only guards runaway output. */
const MAX_LINE_CHARS = 8_000;

export type SpeechLang = "ZH" | "EN";

/** Parsed JSON Lines events from the macos-speech-transcriber helper. */
export type SpeechHelperEvent =
  | { type: "waiting"; message: string }
  | { type: "ready" }
  | { type: "partial"; text: string; lang: SpeechLang }
  | { type: "level"; value: number }
  | { type: "final"; text: string; lang: SpeechLang }
  | { type: "error"; message: string };

export type SpeechStopResult = {
  text: string;
  lang: SpeechLang | null;
};

/**
 * Resolve the speech transcriber helper binary. Mirrors windowCapture.ts:
 * packaged extraResources first, then the dev/preview build output.
 */
export function speechTranscriberHelperPath(): string {
  const override = process.env.SPEECH_TRANSCRIBER_HELPER_PATH?.trim();
  if (override) return resolve(override);

  const candidates = [
    // Packaged .app: extraResources → Contents/Resources/helpers/…
    ...(typeof process.resourcesPath === "string" && process.resourcesPath
      ? [join(process.resourcesPath, "helpers", "macos-speech-transcriber")]
      : []),
    // Dev / electron-vite preview: built by build-speech-transcriber.mjs
    join(process.cwd(), "build", "helpers", "macos-speech-transcriber"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // Fall back to the unpackaged build path for a clearer ENOENT message.
  return join(process.cwd(), "build", "helpers", "macos-speech-transcriber");
}

function speechLang(value: unknown): SpeechLang | null {
  return value === "ZH" || value === "EN" ? value : null;
}

/**
 * Parse one helper stdout line into a typed event. Returns null for blank or
 * malformed lines — the caller logs and drops them instead of throwing.
 */
export function parseSpeechEventLine(raw: string): SpeechHelperEvent | null {
  const line = raw.trim();
  if (!line) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  switch (record.type) {
    case "waiting":
    case "error": {
      const message =
        typeof record.message === "string" && record.message.trim()
          ? record.message.trim()
          : "";
      if (!message) return null;
      return record.type === "waiting"
        ? { type: "waiting", message }
        : { type: "error", message };
    }
    case "ready":
      return { type: "ready" };
    case "partial":
    case "final": {
      const text = typeof record.text === "string" ? record.text : "";
      const lang = speechLang(record.lang);
      if (!lang || (record.type === "partial" && !text)) return null;
      return record.type === "partial"
        ? { type: "partial", text, lang }
        : { type: "final", text, lang };
    }
    case "level": {
      const value =
        typeof record.value === "number" && Number.isFinite(record.value)
          ? Math.min(1, Math.max(0, record.value))
          : null;
      if (value === null) return null;
      return { type: "level", value };
    }
    default:
      return null;
  }
}

type SpeechSession = {
  child: ChildProcess;
  webContents: WebContents;
  /** Partial stdout lines waiting for "\n". */
  stdoutBuf: string;
  /** Per-event-type counters for the debug log (level events are noisy). */
  counts: Record<string, number>;
  lastPartial: { text: string; lang: SpeechLang } | null;
  finalResult: { text: string; lang: SpeechLang } | null;
  stopPromise: Promise<SpeechStopResult> | null;
};

/** One recording session per renderer webContents (like terminalIpc). */
const sessions = new Map<number, SpeechSession>();

function send(session: SpeechSession, event: SpeechHelperEvent): void {
  const wc = session.webContents;
  if (wc.isDestroyed()) return;
  try {
    wc.send("speech:event", event);
  } catch {
    // Ignore — window closing / not ready / non-cloneable edge cases.
  }
}

function handleEvent(session: SpeechSession, event: SpeechHelperEvent): void {
  const count = (session.counts[event.type] ?? 0) + 1;
  session.counts[event.type] = count;
  // First event of each type logs in full; noisy types checkpoint every 100.
  const noisy = event.type === "level" || event.type === "partial";
  if (count === 1 || !noisy || count % 100 === 0) {
    speechDebugLog(
      `event type=${event.type} #${count} ${
        "value" in event && typeof event.value === "number"
          ? `value=${event.value.toFixed(3)}`
          : "message" in event
            ? `message=${event.message}`
            : "text" in event
              ? `text="${event.text.slice(0, 80)}"`
              : ""
      }`,
    );
  }
  switch (event.type) {
    case "final":
      session.finalResult = { text: event.text, lang: event.lang };
      send(session, event);
      return;
    case "partial":
      session.lastPartial = { text: event.text, lang: event.lang };
      send(session, event);
      return;
    default:
      send(session, event);
  }
}

function drainStdout(session: SpeechSession, chunk: string): void {
  session.stdoutBuf += chunk;
  if (session.stdoutBuf.length > MAX_LINE_CHARS * 4) {
    session.stdoutBuf = session.stdoutBuf.slice(-MAX_LINE_CHARS);
  }
  let newline = session.stdoutBuf.indexOf("\n");
  while (newline >= 0) {
    const line = session.stdoutBuf.slice(0, newline);
    session.stdoutBuf = session.stdoutBuf.slice(newline + 1);
    const event = parseSpeechEventLine(line);
    if (event) {
      handleEvent(session, event);
    } else if (line.trim()) {
      speechDebugLog(`dropped malformed line: ${line.slice(0, 300)}`);
    }
    newline = session.stdoutBuf.indexOf("\n");
  }
}

/** Close stdin, await the helper's final line, escalate on timeout. */
function stopSession(session: SpeechSession): Promise<SpeechStopResult> {
  if (session.stopPromise) return session.stopPromise;
  const fallback = (): SpeechStopResult => ({
    text: session.lastPartial?.text ?? session.finalResult?.text ?? "",
    lang: session.lastPartial?.lang ?? session.finalResult?.lang ?? null,
  });

  session.stopPromise = new Promise<SpeechStopResult>((resolveStop) => {
    let settled = false;
    const finish = (result: SpeechStopResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(finalTimer);
      clearTimeout(killTimer);
      resolveStop(result);
    };

    // Final line (or a fallback when the helper closes without one).
    const finalTimer = setTimeout(() => {
      try {
        session.child.kill("SIGTERM");
      } catch {
        // ignore
      }
      killTimer = setTimeout(() => {
        try {
          session.child.kill("SIGKILL");
        } catch {
          // ignore
        }
        finish(fallback());
      }, KILL_TIMEOUT_MS);
    }, FINAL_TIMEOUT_MS);
    let killTimer: ReturnType<typeof setTimeout> = setTimeout(() => {}, 0);

    // Poll-free: the close handler below resolves once the process is gone.
    const onClose = () => {
      const final = session.finalResult;
      finish(
        final
          ? { text: final.text, lang: final.lang }
          : fallback(),
      );
    };
    session.child.once("close", onClose);

    try {
      session.child.stdin?.end();
    } catch {
      // stdin already gone — close handler / timers still settle this.
    }
  });
  return session.stopPromise;
}

function destroySession(webContentsId: number): void {
  const session = sessions.get(webContentsId);
  if (!session) return;
  sessions.delete(webContentsId);
  try {
    session.child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

/**
 * Push-to-talk speech transcription IPC. The helper streams JSON Lines events
 * (waiting/ready/partial/level/final/error) on stdout; speech:event forwards
 * them live, and speech:stop resolves with the committed transcript.
 */
export function registerSpeechTranscriptionIpc(): void {
  ipcMain.handle("speech:start", async (event) => {
    const webContents = event.sender;
    speechDebugLog(`speech:start webContents=${webContents.id}`);
    const existing = sessions.get(webContents.id);
    if (existing && !existing.child.killed && !existing.finalResult) {
      return { started: true };
    }
    if (existing) {
      sessions.delete(webContents.id);
    }

    if (process.platform !== "darwin") {
      throw new Error("Voice input is only available on macOS.");
    }
    // macOS 26 gates the new Speech framework helper (compile target match).
    const systemVersion = process.getSystemVersion();
    const major = Number.parseInt(systemVersion.split(".")[0] ?? "", 10);
    if (Number.isFinite(major) && major < 26) {
      throw new Error("Voice input requires macOS 26 or later.");
    }

    // Gate microphone TCC here — attributed to this Electron/JellyBot app,
    // which owns the prompt reliably. The CLI helper's own request path is
    // only a fallback: its responsible-process attribution is unstable when
    // spawned through npm→Electron→helper in dev, and can hang the
    // requestAccess callback (no prompt, stuck "waiting" state).
    //
    // macOS TCC rules (see Electron systemPreferences docs):
    // - A denied request never re-prompts; the promise resolves with the
    //   existing status. Recovery = user toggles System Settings → restart.
    // - A Settings change made while the app runs is NOT seen by the running
    //   process — a restart is required for it to take effect.
    const micStatus = systemPreferences.getMediaAccessStatus("microphone");
    speechDebugLog(`microphone TCC status: ${micStatus}`);
    console.log(`[speech] microphone TCC status: ${micStatus}`);
    if (micStatus === "denied" || micStatus === "restricted") {
      throw new Error(
        "Microphone access is off for JellyBot. Turn it on in System Settings → Privacy & Security → Microphone, then restart the app.",
      );
    }
    if (micStatus !== "granted") {
      // not-determined / unknown: the one-shot system prompt (helper events
      // are not streaming yet, so the waiting state goes out of band).
      try {
        webContents.send("speech:event", {
          type: "waiting",
          message: "Waiting for microphone permission…",
        });
      } catch {
        // window may already be gone
      }
      // Race the ask with a status-poll fallback: a swallowed/eaten prompt
      // must not hang the renderer's recording state forever.
      const granted = await Promise.race([
        systemPreferences.askForMediaAccess("microphone"),
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            resolve(
              systemPreferences.getMediaAccessStatus("microphone") ===
                "granted",
            );
          }, PERMISSION_ASK_TIMEOUT_MS);
        }),
      ]);
      console.log(`[speech] askForMediaAccess resolved: ${granted}`);
      speechDebugLog(`askForMediaAccess resolved: ${granted}`);
      if (!granted) {
        throw new Error(
          "Microphone permission was not granted. Allow it when prompted (or in System Settings → Privacy & Security → Microphone), then restart the app and try again.",
        );
      }
    }

    const helperPath = speechTranscriberHelperPath();
    speechDebugLog(`helper path: ${helperPath} exists=${existsSync(helperPath)}`);
    if (!existsSync(helperPath)) {
      throw new Error(
        `The speech transcriber helper is unavailable at ${helperPath}. Rebuild the app (npm run build) and try again.`,
      );
    }

    const child = spawn(helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    console.log(`[speech] helper spawned: pid=${child.pid ?? "?"} path=${helperPath}`);
    speechDebugLog(`helper spawned: pid=${child.pid ?? "?"}`);
    const session: SpeechSession = {
      child,
      webContents,
      stdoutBuf: "",
      counts: {},
      lastPartial: null,
      finalResult: null,
      stopPromise: null,
    };
    sessions.set(webContents.id, session);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      drainStdout(session, chunk);
    });
    // The helper reports failures as JSON error events; stderr is unexpected.
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      const text = chunk.trim();
      if (!text) return;
      speechDebugLog(`helper stderr: ${text.slice(0, 500)}`);
      send(session, { type: "error", message: text });
    });
    child.on("error", (err) => {
      console.error(`[speech] helper spawn error: ${err.message}`);
      speechDebugLog(`helper spawn error: ${err.message}`);
      send(session, { type: "error", message: err.message });
      sessions.delete(webContents.id);
    });
    child.on("close", (code, signal) => {
      console.log(`[speech] helper closed: code=${code} signal=${signal}`);
      speechDebugLog(
        `helper closed: code=${code} signal=${signal} counts=${JSON.stringify(session.counts)}`,
      );
      if (sessions.get(webContents.id) === session) {
        sessions.delete(webContents.id);
      }
    });

    webContents.once("destroyed", () => {
      destroySession(webContents.id);
    });

    return { started: true };
  });

  ipcMain.handle(
    "speech:stop",
    async (event): Promise<SpeechStopResult> => {
      const session = sessions.get(event.sender.id);
      speechDebugLog(`speech:stop session=${session ? "live" : "none"}`);
      if (!session) {
        return { text: "", lang: null };
      }
      const result = await stopSession(session);
      sessions.delete(event.sender.id);
      speechDebugLog(
        `speech:stop result len=${result.text.length} lang=${result.lang ?? "-"} counts=${JSON.stringify(session.counts)}`,
      );
      return result;
    },
  );
}
