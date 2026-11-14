/**
 * One Electron inspect target (main Node or a Chromium page) as a DAP-shaped runtime.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { LineBreakpoint } from "./dapSession.js";
import type {
  DapEvaluateBody,
  DapStackFrame,
  DapStoppedEvent,
  DapThread,
  DapVariable,
} from "./dapTypes.js";
import { CdpClient } from "./cdpClient.js";
import { cdpBreakpointLocations, resolveWorkspacePath, scriptUrlMatchesFile } from "./cdpBreakpointUrl.js";
import {
  SourceMapIndex,
  sourceFilePath,
  type SourceMapPayload,
} from "./sourceMap.js";

type CdpRemoteObject = {
  type?: string;
  subtype?: string;
  className?: string;
  description?: string;
  value?: unknown;
  unserializableValue?: string;
  objectId?: string;
};

type CdpCallFrame = {
  callFrameId: string;
  functionName?: string;
  url?: string;
  location: { scriptId: string; lineNumber: number; columnNumber?: number };
  scopeChain?: Array<{ type?: string; object?: CdpRemoteObject }>;
};

type CdpScript = {
  scriptId: string;
  url: string;
  sourceMapURL?: string;
  map: SourceMapIndex | null;
};

const SKIP_SCOPES = new Set(["global", "with", "module"]);
const THREAD: DapThread = { id: 1, name: "JavaScript" };

export type ElectronCdpKind = "node" | "chrome";

export type ElectronCdpSessionInput = {
  id: string;
  kind: ElectronCdpKind;
  label: string;
  webSocketUrl: string;
  projectRoot: string;
};

export class ElectronCdpSession {
  readonly id: string;
  readonly kind: ElectronCdpKind;
  readonly label: string;
  private readonly projectRoot: string;
  private readonly webSocketUrl: string;
  private cdp: CdpClient | null = null;
  private readonly scripts = new Map<string, CdpScript>();
  private readonly breakpoints = new Map<string, LineBreakpoint[]>();
  private readonly cdpBreakpoints = new Map<string, string[]>();
  private pausedFrames: CdpCallFrame[] | null = null;
  private readonly frameIds = new Map<number, string>();
  private readonly objects = new Map<number, string>();
  private nextRef = 1;
  private readonly stoppedListeners = new Set<(ev: DapStoppedEvent) => void>();
  private readonly resumedListeners = new Set<() => void>();
  private readonly endedListeners = new Set<() => void>();
  private readonly consoleListeners = new Set<
    (entry: { direction: "receive" | "error"; text: string }) => void
  >();
  private rebindTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(input: ElectronCdpSessionInput) {
    this.id = input.id;
    this.kind = input.kind;
    this.label = input.label;
    this.projectRoot = input.projectRoot;
    this.webSocketUrl = input.webSocketUrl;
  }

  onStopped(handler: (ev: DapStoppedEvent) => void): () => void {
    this.stoppedListeners.add(handler);
    return () => {
      this.stoppedListeners.delete(handler);
    };
  }

  onResumed(handler: () => void): () => void {
    this.resumedListeners.add(handler);
    return () => {
      this.resumedListeners.delete(handler);
    };
  }

  onEnded(handler: () => void): () => void {
    this.endedListeners.add(handler);
    return () => {
      this.endedListeners.delete(handler);
    };
  }

  onConsole(
    handler: (entry: { direction: "receive" | "error"; text: string }) => void,
  ): () => void {
    this.consoleListeners.add(handler);
    return () => {
      this.consoleListeners.delete(handler);
    };
  }

  async start(): Promise<void> {
    const cdp = await CdpClient.connect(this.webSocketUrl);
    this.cdp = cdp;
    cdp.onEvent((method, params) => this.onCdpEvent(method, params));
    cdp.onClose(() => {
      this.cdp = null;
      this.pausedFrames = null;
      for (const handler of this.endedListeners) handler();
    });
    await cdp.send("Runtime.enable");
    await cdp.send("Debugger.enable");
    try {
      await cdp.send("Debugger.setBlackboxPatterns", {
        patterns: ["node_modules", "node:internals"],
      });
    } catch {
      /* optional */
    }
    try {
      await cdp.send("Runtime.runIfWaitingForDebugger");
    } catch {
      /* not waiting */
    }
    await this.rebindAllBreakpoints();
  }

  async replaceBreakpoints(path: string, breakpoints: LineBreakpoint[]): Promise<void> {
    this.breakpoints.set(path, breakpoints);
    const cdp = this.cdp;
    const previous = this.cdpBreakpoints.get(path) ?? [];
    if (cdp) {
      for (const id of previous) {
        try {
          await cdp.send("Debugger.removeBreakpoint", { breakpointId: id });
        } catch {
          /* already gone */
        }
      }
    }
    this.cdpBreakpoints.set(path, []);
    if (!cdp || breakpoints.length === 0) return;
    await this.ensureMapsFor(path);
    const ids: string[] = [];
    for (const bp of breakpoints) {
      for (const loc of cdpBreakpointLocations(
        path,
        bp.line,
        this.projectRoot,
        this.scripts.values(),
      )) {
        try {
          const result = await cdp.send<{ breakpointId?: string }>(
            "Debugger.setBreakpointByUrl",
            {
              lineNumber: loc.lineNumber,
              ...(loc.url ? { url: loc.url } : {}),
              ...(loc.urlRegex ? { urlRegex: loc.urlRegex } : {}),
              ...(bp.condition?.trim() ? { condition: bp.condition.trim() } : {}),
            },
          );
          if (result.breakpointId) ids.push(result.breakpointId);
        } catch {
          /* pending until the script loads */
        }
      }
    }
    this.cdpBreakpoints.set(path, ids);
  }

  async threads(): Promise<DapThread[]> {
    return [THREAD];
  }

  async stack(_threadId?: number): Promise<DapStackFrame[]> {
    if (!this.pausedFrames) return [];
    this.frameIds.clear();
    return this.pausedFrames.map((frame, index) => {
      const id = index + 1;
      this.frameIds.set(id, frame.callFrameId);
      const loc = this.originalLocation(frame);
      const name = frame.functionName?.trim() || "(anonymous)";
      const sourcePath = loc.path;
      return {
        id,
        name,
        line: loc.line,
        column: loc.column,
        ...(sourcePath
          ? { source: { path: sourcePath, name: basenameOf(sourcePath) } }
          : {}),
      };
    });
  }

  async locals(frameId?: number): Promise<DapVariable[]> {
    const frame = this.callFrame(frameId);
    if (!frame) return [];
    const out: DapVariable[] = [];
    for (const scope of frame.scopeChain ?? []) {
      const type = (scope.type ?? "").toLowerCase();
      if (SKIP_SCOPES.has(type) || !scope.object?.objectId) continue;
      out.push(...(await this.properties(scope.object.objectId)));
    }
    return out;
  }

  async variables(variablesReference: number): Promise<DapVariable[]> {
    const objectId = this.objects.get(variablesReference);
    if (!objectId) return [];
    return this.properties(objectId);
  }

  async evaluateHover(expression: string, frameId: number): Promise<DapEvaluateBody> {
    const cdp = this.requireCdp();
    const callFrameId = this.frameIds.get(frameId);
    if (!callFrameId || !this.pausedFrames) {
      throw new Error("Process is not paused");
    }
    const result = await cdp.send<{
      result?: CdpRemoteObject;
      exceptionDetails?: unknown;
    }>("Debugger.evaluateOnCallFrame", {
      callFrameId,
      expression,
      silent: true,
      generatePreview: true,
    });
    if (result.exceptionDetails) {
      throw new Error("Evaluation failed");
    }
    return this.toEvaluate(result.result ?? { type: "undefined", description: "undefined" });
  }

  async continue(): Promise<void> {
    await this.requireCdp().send("Debugger.resume");
  }

  async next(): Promise<void> {
    await this.requireCdp().send("Debugger.stepOver");
  }

  async stepIn(): Promise<void> {
    await this.requireCdp().send("Debugger.stepInto");
  }

  async stepOut(): Promise<void> {
    await this.requireCdp().send("Debugger.stepOut");
  }

  async pauseMainThread(): Promise<void> {
    await this.requireCdp().send("Debugger.pause");
  }

  async resumeAll(): Promise<void> {
    try {
      await this.continue();
    } catch {
      /* already running */
    }
  }

  async dispose(): Promise<void> {
    if (this.rebindTimer) {
      clearTimeout(this.rebindTimer);
      this.rebindTimer = null;
    }
    this.cdp?.dispose();
    this.cdp = null;
    this.pausedFrames = null;
  }

  private onCdpEvent(method: string, params: unknown): void {
    if (method === "Debugger.scriptParsed") {
      const body = params as {
        scriptId?: string;
        url?: string;
        sourceMapURL?: string;
      };
      if (!body.scriptId) return;
      void this.rememberScript(body.scriptId, body.url ?? "", body.sourceMapURL);
      return;
    }
    if (method === "Debugger.paused") {
      const body = params as {
        reason?: string;
        hitBreakpoints?: string[];
        callFrames?: CdpCallFrame[];
      };
      this.pausedFrames = body.callFrames ?? [];
      this.frameIds.clear();
      this.objects.clear();
      const ev: DapStoppedEvent = {
        reason: mapPauseReason(body.reason, body.hitBreakpoints),
        threadId: THREAD.id,
        allThreadsStopped: true,
        ...(body.hitBreakpoints?.length
          ? { hitBreakpointIds: body.hitBreakpoints.map((_, i) => i + 1) }
          : {}),
      };
      for (const handler of this.stoppedListeners) handler(ev);
      return;
    }
    if (method === "Debugger.resumed") {
      this.pausedFrames = null;
      this.frameIds.clear();
      this.objects.clear();
      for (const handler of this.resumedListeners) handler();
      return;
    }
    if (method === "Runtime.consoleAPICalled") {
      const body = params as { type?: string; args?: CdpRemoteObject[] };
      const text = (body.args ?? []).map((arg) => formatRemote(arg).value).join(" ");
      if (text) {
        const direction =
          body.type === "error" || body.type === "warning" ? "error" : "receive";
        for (const handler of this.consoleListeners) handler({ direction, text });
      }
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const body = params as {
        exceptionDetails?: { text?: string; exception?: CdpRemoteObject };
      };
      const text =
        body.exceptionDetails?.exception?.description ??
        body.exceptionDetails?.text ??
        "Uncaught exception";
      for (const handler of this.consoleListeners) {
        handler({ direction: "error", text });
      }
    }
  }

  private async rememberScript(
    scriptId: string,
    url: string,
    sourceMapURL?: string,
  ): Promise<void> {
    const script: CdpScript = { scriptId, url, map: null };
    if (sourceMapURL) script.sourceMapURL = sourceMapURL;
    this.scripts.set(scriptId, script);
    if (sourceMapURL) {
      script.map = await loadSourceMap(url, sourceMapURL);
    }
    this.scheduleRebind();
  }

  private scheduleRebind(): void {
    if (this.rebindTimer) clearTimeout(this.rebindTimer);
    this.rebindTimer = setTimeout(() => {
      this.rebindTimer = null;
      void this.rebindAllBreakpoints();
    }, 50);
  }

  private async ensureMapsFor(filePath: string): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const script of this.scripts.values()) {
      if (script.map) continue;
      if (!scriptUrlMatchesFile(script.url, filePath)) continue;
      jobs.push(
        (async () => {
          script.map = await loadInlineSourceMapFromScript(script.url);
        })(),
      );
    }
    if (jobs.length > 0) await Promise.all(jobs);
  }

  private async rebindAllBreakpoints(): Promise<void> {
    if (!this.cdp) return;
    for (const [path, breakpoints] of this.breakpoints) {
      await this.replaceBreakpoints(path, breakpoints);
    }
  }

  private originalLocation(frame: CdpCallFrame): {
    path: string | null;
    line: number;
    column: number;
  } {
    const script = this.scripts.get(frame.location.scriptId);
    const generatedLine = frame.location.lineNumber;
    const generatedCol = frame.location.columnNumber ?? 0;
    const mapped = script?.map?.originalPositionFor(generatedLine, generatedCol);
    const url = script?.url || frame.url || "";
    if (mapped) {
      const path =
        resolveWorkspacePath(mapped.source, url, this.projectRoot) ??
        sourceFilePath(mapped.source);
      return {
        path,
        line: mapped.line,
        column: mapped.column + 1,
      };
    }
    if (!url || url.startsWith("node:") || url.includes("node_modules")) {
      return { path: null, line: generatedLine + 1, column: generatedCol + 1 };
    }
    const path = resolveWorkspacePath(url, url, this.projectRoot);
    if (path) {
      return { path, line: generatedLine + 1, column: generatedCol + 1 };
    }
    try {
      return {
        path: url.startsWith("file:") ? fileURLToPath(url) : url,
        line: generatedLine + 1,
        column: generatedCol + 1,
      };
    } catch {
      return { path: url, line: generatedLine + 1, column: generatedCol + 1 };
    }
  }

  private callFrame(frameId?: number): CdpCallFrame | null {
    if (!this.pausedFrames) return null;
    if (typeof frameId !== "number") return this.pausedFrames[0] ?? null;
    const callFrameId = this.frameIds.get(frameId);
    return (
      this.pausedFrames.find((frame) => frame.callFrameId === callFrameId) ?? null
    );
  }

  private async properties(objectId: string): Promise<DapVariable[]> {
    const cdp = this.requireCdp();
    const result = await cdp.send<{
      result?: Array<{ name?: string; value?: CdpRemoteObject }>;
    }>("Runtime.getProperties", {
      objectId,
      ownProperties: true,
      generatePreview: true,
    });
    const out: DapVariable[] = [];
    for (const prop of result.result ?? []) {
      const name = prop.name ?? "";
      if (!name || name.startsWith("__")) continue;
      out.push(this.toVariable(name, prop.value ?? { type: "undefined" }));
    }
    return out;
  }

  private toVariable(name: string, value: CdpRemoteObject): DapVariable {
    const formatted = formatRemote(value);
    return {
      name,
      value: formatted.value,
      ...(formatted.type ? { type: formatted.type } : {}),
      variablesReference: formatted.objectId
        ? this.trackObject(formatted.objectId)
        : 0,
    };
  }

  private toEvaluate(value: CdpRemoteObject): DapEvaluateBody {
    const formatted = formatRemote(value);
    return {
      result: formatted.value,
      ...(formatted.type ? { type: formatted.type } : {}),
      variablesReference: formatted.objectId
        ? this.trackObject(formatted.objectId)
        : 0,
    };
  }

  private trackObject(objectId: string): number {
    const ref = ++this.nextRef;
    this.objects.set(ref, objectId);
    return ref;
  }

  private requireCdp(): CdpClient {
    if (!this.cdp) throw new Error("Electron debugger is not connected");
    return this.cdp;
  }
}

function mapPauseReason(reason?: string, hits?: string[]): string {
  if (hits && hits.length > 0) return "breakpoint";
  if (reason === "exception") return "exception";
  if (reason === "step") return "step";
  if (reason === "other" || reason === "ambiguous") return "pause";
  return reason || "pause";
}

function formatRemote(obj: CdpRemoteObject): {
  value: string;
  type?: string;
  objectId?: string;
} {
  const type = obj.className || obj.subtype || obj.type;
  if (obj.unserializableValue) {
    return { value: obj.unserializableValue, ...(type ? { type } : {}) };
  }
  if (obj.value !== undefined) {
    if (obj.type === "string") {
      return { value: JSON.stringify(obj.value), type: "string" };
    }
    return { value: String(obj.value), ...(type ? { type } : {}) };
  }
  const value = obj.description ?? obj.type ?? "Object";
  return {
    value,
    ...(type ? { type } : {}),
    ...(obj.objectId ? { objectId: obj.objectId } : {}),
  };
}

function basenameOf(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || path;
}

async function loadInlineSourceMapFromScript(
  scriptUrl: string,
): Promise<SourceMapIndex | null> {
  if (!/^https?:\/\//i.test(scriptUrl)) return null;
  if (scriptUrl.includes("node_modules")) return null;
  try {
    const res = await fetch(scriptUrl);
    if (!res.ok) return null;
    const text = await res.text();
    const marker = text.lastIndexOf("sourceMappingURL=");
    if (marker < 0) return null;
    const spec = text.slice(marker + "sourceMappingURL=".length).trim().split(/\s/, 1)[0];
    if (!spec) return null;
    return loadSourceMap(scriptUrl, spec);
  } catch {
    return null;
  }
}

async function loadSourceMap(
  scriptUrl: string,
  sourceMapURL: string,
): Promise<SourceMapIndex | null> {
  try {
    let raw: string;
    let mapHref = sourceMapURL;
    if (sourceMapURL.startsWith("data:")) {
      const comma = sourceMapURL.indexOf(",");
      const meta = sourceMapURL.slice(5, comma);
      const payload = sourceMapURL.slice(comma + 1);
      raw = /base64/i.test(meta)
        ? Buffer.from(payload, "base64").toString("utf8")
        : decodeURIComponent(payload);
      mapHref = scriptUrl;
    } else {
      const abs = new URL(sourceMapURL, scriptUrl || undefined).href;
      mapHref = abs;
      if (abs.startsWith("file:")) {
        raw = await readFile(fileURLToPath(abs), "utf8");
      } else if (abs.startsWith("http:") || abs.startsWith("https:")) {
        const res = await fetch(abs);
        if (!res.ok) return null;
        raw = await res.text();
      } else {
        return null;
      }
    }
    return SourceMapIndex.parse(JSON.parse(raw) as SourceMapPayload, mapHref);
  } catch {
    return null;
  }
}
