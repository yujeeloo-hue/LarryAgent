import type { LanguageServerId, LanguageServerProgressEvent } from "./progressTypes.js";

type Kind = "loading" | "diagnosing";
type TokenState = { kind: Kind; message: string; percent?: number };
type ProgressValue = { kind?: unknown; title?: unknown; message?: unknown; percentage?: unknown };
type PhaseEvent = LanguageServerProgressEvent extends infer E
  ? E extends unknown ? Omit<E, "server" | "rootPath"> : never
  : never;

export const PROGRESS_SETTLE_MS = 1500;

export class LspProgressTracker {
  private readonly tokens = new Map<string, TokenState>();
  private last = "";
  private settleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly server: LanguageServerId,
    private readonly rootPath: string,
    private readonly emit: (event: LanguageServerProgressEvent) => void,
    private readonly settleMs = PROGRESS_SETTLE_MS,
  ) {}

  starting(): void {
    this.reset();
    this.send({ phase: "starting" });
  }

  initialized(): void {
    this.cancelSettle();
    if (this.tokens.size > 0) return;
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      if (this.tokens.size === 0) this.send({ phase: "idle" });
    }, this.settleMs);
    this.settleTimer.unref?.();
  }

  failed(message: string): void {
    this.reset();
    this.send({ phase: "failed", message });
  }

  idle(): void {
    this.reset();
    this.send({ phase: "idle" });
  }

  handle(params: unknown): void {
    const { token, value } = (params ?? {}) as { token?: unknown; value?: ProgressValue };
    if ((typeof token !== "string" && typeof token !== "number") || !value || typeof value !== "object") return;
    const key = String(token);
    const message = typeof value.message === "string" ? value.message.trim() : "";
    const percent =
      typeof value.percentage === "number" && Number.isFinite(value.percentage)
        ? Math.max(0, Math.min(100, Math.round(value.percentage)))
        : undefined;
    if (value.kind === "begin") {
      this.cancelSettle();
      const title = typeof value.title === "string" ? value.title.trim() : "";
      const state: TokenState = {
        kind: /diagnos/i.test(title) ? "diagnosing" : "loading",
        message: message && message !== title ? message : "",
        ...(percent !== undefined ? { percent } : {}),
      };
      this.tokens.set(key, state);
      this.publish(state);
      return;
    }
    const state = this.tokens.get(key);
    if (!state) return;
    if (value.kind === "report") {
      if (message) state.message = message;
      if (percent !== undefined) state.percent = percent;
      this.publish(state);
      return;
    }
    if (value.kind === "end") {
      this.tokens.delete(key);
      const next = [...this.tokens.values()].at(-1);
      if (next) this.publish(next);
      else this.send({ phase: "idle" });
    }
  }

  private publish(state: TokenState): void {
    if (state.kind === "diagnosing") {
      const { percent } = state;
      this.send({ phase: "diagnosing", ...(percent !== undefined ? { percent } : {}) });
      return;
    }
    this.send({ phase: "loading", ...(state.message ? { message: state.message } : {}) });
  }

  private reset(): void {
    this.cancelSettle();
    this.tokens.clear();
  }

  private cancelSettle(): void {
    if (this.settleTimer === null) return;
    clearTimeout(this.settleTimer);
    this.settleTimer = null;
  }

  private send(phase: PhaseEvent): void {
    const event = { server: this.server, rootPath: this.rootPath, ...phase } as LanguageServerProgressEvent;
    const key = JSON.stringify(event);
    if (key === this.last) return;
    this.last = key;
    this.emit(event);
  }
}
