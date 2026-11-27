const MAX_CHUNKS = 3000;
const TRIM_BATCH = 500;

export type ChunkKind = "stdout" | "stderr" | "meta" | "agent";

export type LineTone = "success" | "warning" | "error";

export interface LiveLine {
  readonly text: string;
  set(text: string, tone?: LineTone | null): void;
}

export interface LineSink {
  appendOutput(text: string, kind?: ChunkKind): void;
  appendEndLine(text: string, ok: boolean): void;
  appendDivider(): void;
  openLine(kind: ChunkKind): LiveLine;
  clear(): void;
}

export class ChunkLog implements LineSink {
  constructor(readonly el: HTMLElement) {}

  appendOutput(text: string, kind: ChunkKind = "stdout"): void {
    const span = document.createElement("span");
    span.className = `terminal-pane-chunk is-${kind}`;
    span.textContent = text;
    this.el.append(span);
    this.trim();
    this.scrollToEnd();
  }

  appendEndLine(text: string, ok: boolean): void {
    this.appendOutput(`${text}\n`, ok ? "meta" : "stderr");
  }

  appendDivider(): void {
    const rule = document.createElement("span");
    rule.className = "terminal-pane-divider";
    rule.setAttribute("role", "separator");
    rule.setAttribute("aria-hidden", "true");
    this.el.append(rule);
    this.trim();
    this.scrollToEnd();
  }

  openLine(kind: ChunkKind): LiveLine {
    const span = document.createElement("span");
    span.className = `terminal-pane-chunk is-${kind}`;
    this.el.append(span);
    this.trim();
    return {
      get text() {
        return span.textContent ?? "";
      },
      set: (text, tone) => {
        span.textContent = text;
        if (tone === null) span.removeAttribute("data-build-tone");
        else if (tone) span.dataset.buildTone = tone;
        this.scrollToEnd();
      },
    };
  }

  clear(): void {
    this.el.replaceChildren();
  }

  private trim(): void {
    const count = this.el.childElementCount;
    if (count <= MAX_CHUNKS) return;
    const drop = Math.min(TRIM_BATCH, count - MAX_CHUNKS);
    for (let i = 0; i < drop && this.el.firstElementChild; i++) {
      this.el.firstElementChild.remove();
    }
  }

  private scrollToEnd(): void {
    this.el.scrollTop = this.el.scrollHeight;
  }
}
