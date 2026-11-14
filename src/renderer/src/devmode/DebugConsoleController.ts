import {
  DebugConsoleView,
  type DebugConsoleRow,
} from "./DebugConsoleView.js";

const MAX_ROWS = 3_000;

/** State/filter/clipboard logic for the Debug Console. */
export class DebugConsoleController {
  private rows: DebugConsoleRow[] = [];
  private filter = "";
  private unwatchOutput: (() => void) | null = null;
  private unwatchState: (() => void) | null = null;
  /** Rows accepted since the last frame, still missing from the DOM. */
  private unpainted: DebugConsoleRow[] = [];
  private frame: number | null = null;

  constructor(readonly view: DebugConsoleView) {
    view.onFilterChange = (value) => {
      this.filter = value.trim().toLowerCase();
      this.paint();
    };
    view.onCopy = () => {
      void this.copyVisible();
    };
  }

  mount(): void {
    const bridge = window.jellybot;
    if (
      !bridge?.onDebugOutput ||
      !bridge.onDebugState ||
      !bridge.getDebugState
    ) {
      return;
    }
    this.unwatchOutput = bridge.onDebugOutput((payload) => {
      for (const entry of payload.entries) this.append(entry, false);
      this.schedulePaint();
    });
    this.unwatchState = bridge.onDebugState((snapshot) => {
      // A fresh session starts with exactly one lifecycle row.
      if ((snapshot.console?.length ?? 0) === 1) {
        this.apply(snapshot.console ?? []);
      }
    });
    void bridge.getDebugState().then((snapshot) => {
      this.merge(snapshot.console ?? []);
    });
  }

  destroy(): void {
    this.unwatchOutput?.();
    this.unwatchOutput = null;
    this.unwatchState?.();
    this.unwatchState = null;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
    this.unpainted = [];
  }

  /** The unified panel toolbar owns the single clear-output action. */
  clear(): void {
    this.rows = [];
    this.paint();
  }

  private apply(rows: DebugConsoleRow[]): void {
    if (sameTail(this.rows, rows)) return;
    this.rows = [...rows];
    this.paint();
  }

  private merge(rows: DebugConsoleRow[]): void {
    for (const row of rows) this.append(row, false);
    this.schedulePaint();
  }

  private append(row: DebugConsoleRow, paint = true): void {
    const tail = this.rows[this.rows.length - 1];
    if (
      tail?.timestamp === row.timestamp &&
      tail.direction === row.direction &&
      tail.text === row.text
    ) {
      return;
    }
    this.rows.push(row);
    this.unpainted.push(row);
    if (this.rows.length > MAX_ROWS) {
      this.rows.splice(0, this.rows.length - MAX_ROWS);
    }
    if (paint) this.schedulePaint();
  }

  /** Coalesce a burst of trace rows into one DOM write per frame. */
  private schedulePaint(): void {
    if (this.frame !== null) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  private flush(): void {
    const pending = this.unpainted;
    this.unpainted = [];
    // A filter has to re-evaluate every row, so it keeps the full repaint.
    if (this.filter) {
      this.paint();
      return;
    }
    this.view.appendRows(pending, this.rows.length, MAX_ROWS);
  }

  private paint(): void {
    if (this.frame !== null) {
      cancelAnimationFrame(this.frame);
      this.frame = null;
    }
    this.unpainted = [];
    this.view.setRows(this.visibleRows(), this.rows.length);
  }

  private visibleRows(): DebugConsoleRow[] {
    if (!this.filter) return this.rows;
    return this.rows.filter((row) => {
      const haystack = `${row.direction} ${row.text}`.toLowerCase();
      return this.filter
        .split(/\s+/)
        .filter(Boolean)
        .every((term) => haystack.includes(term));
    });
  }

  private async copyVisible(): Promise<void> {
    const text = this.asText(this.visibleRows());
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    this.view.flashCopied();
  }

  private asText(rows: DebugConsoleRow[]): string {
    return rows
      .map((row) => {
        const direction =
          row.direction === "send"
            ? "SEND"
            : row.direction === "receive"
              ? "RECV"
              : "ERROR";
        return `${new Date(row.timestamp).toISOString()} ${direction} ${row.text}`;
      })
      .join("\n");
  }
}

function sameTail(a: DebugConsoleRow[], b: DebugConsoleRow[]): boolean {
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  const left = a[a.length - 1];
  const right = b[b.length - 1];
  return (
    left?.timestamp === right?.timestamp &&
    left?.direction === right?.direction &&
    left?.text === right?.text
  );
}
