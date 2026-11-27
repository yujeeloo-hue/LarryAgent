import type { LuaLsProgressEvent } from "./types.js";

type Kind = "loading" | "diagnosing";
type TokenState = { kind: Kind; message: string; percent?: number };
type ProgressValue = { kind?: unknown; title?: unknown; message?: unknown; percentage?: unknown };

export class LuaProgressTracker {
  private readonly tokens = new Map<string, TokenState>();
  private last = "";

  constructor(
    private readonly rootPath: string,
    private readonly emit: (event: LuaLsProgressEvent) => void,
  ) {}

  starting(): void {
    this.tokens.clear();
    this.send({ rootPath: this.rootPath, phase: "starting" });
  }

  failed(message: string): void {
    this.tokens.clear();
    this.send({ rootPath: this.rootPath, phase: "failed", message });
  }

  idle(): void {
    this.tokens.clear();
    this.send({ rootPath: this.rootPath, phase: "idle" });
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
      else this.send({ rootPath: this.rootPath, phase: "idle" });
    }
  }

  private publish(state: TokenState): void {
    if (state.kind === "diagnosing") {
      const { percent } = state;
      this.send({ rootPath: this.rootPath, phase: "diagnosing", ...(percent !== undefined ? { percent } : {}) });
      return;
    }
    this.send({ rootPath: this.rootPath, phase: "loading", ...(state.message ? { message: state.message } : {}) });
  }

  private send(event: LuaLsProgressEvent): void {
    const key = JSON.stringify(event);
    if (key === this.last) return;
    this.last = key;
    this.emit(event);
  }
}
