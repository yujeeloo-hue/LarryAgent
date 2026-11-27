export type MonoMetrics = { charWidth: number; lineHeight: number };

const TAB_SIZE = 8;
const PROBE_CHARS = 64;

function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f)
    || (code >= 0x2e80 && code <= 0xa4cf)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe30 && code <= 0xfe4f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6);
}

export function visualColumns(text: string): number {
  let cols = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9) cols += TAB_SIZE - (cols % TAB_SIZE);
    else if (code === 10 || code === 13 || (code >= 0xdc00 && code <= 0xdfff)) continue;
    else cols += isWide(code) ? 2 : 1;
  }
  return cols;
}

export function wrappedRows(columns: number, availableWidth: number, charWidth: number): number {
  const perRow = Math.max(1, Math.floor(availableWidth / charWidth));
  return Math.max(1, Math.ceil(columns / perRow));
}

export function measureMono(host: HTMLElement, fallback: MonoMetrics): MonoMetrics {
  const probe = document.createElement("span");
  probe.textContent = "0".repeat(PROBE_CHARS);
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.whiteSpace = "pre";
  host.append(probe);
  const rect = typeof probe.getBoundingClientRect === "function" ? probe.getBoundingClientRect() : null;
  const style = typeof globalThis.getComputedStyle === "function" ? globalThis.getComputedStyle(probe) : null;
  probe.remove();
  const charWidth = rect && rect.width > 0 ? rect.width / PROBE_CHARS : fallback.charWidth;
  const lineHeight = Number.parseFloat(style?.lineHeight ?? "");
  return {
    charWidth,
    lineHeight: Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : fallback.lineHeight,
  };
}
