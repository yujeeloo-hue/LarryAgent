import mermaid from "mermaid";
import {
  createCodeCardHeader,
  MermaidCardIcon,
} from "./CodeCardHeaderView.js";

let mermaidReady = false;
let renderSeq = 0;
/** Serialize all Mermaid SVG renders (conversation waits in order). */
let mermaidQueue: Promise<unknown> = Promise.resolve();

function ensureMermaidInitialized(): void {
  if (mermaidReady) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "dark",
  });
  mermaidReady = true;
}

export function isMermaidFenceLanguage(language?: string): boolean {
  return (language ?? "").trim().toLowerCase() === "mermaid";
}

function createPendingHint(): HTMLElement {
  const pending = document.createElement("p");
  pending.className = "md-paragraph content-card-mermaid-pending-hint";
  pending.textContent = "Mermaid diagram will appear when ready…";
  return pending;
}

/**
 * Plain status line while assistant Markdown is still streaming.
 * No card chrome — the real Mermaid card appears only after SVG is ready.
 */
export function createMermaidStreamingPlaceholder(): HTMLElement {
  return createPendingHint();
}

function buildMermaidCard(source: string, svg: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "content-card content-card-code content-card-mermaid";

  const header = createCodeCardHeader({
    label: "Mermaid",
    icon: MermaidCardIcon,
    copyText: source,
    copyAriaLabel: "Copy diagram source",
  });

  const body = document.createElement("div");
  body.className = "content-card-mermaid-body";

  const wrap = document.createElement("div");
  wrap.className = "content-card-mermaid-svg";
  wrap.innerHTML = svg;
  body.append(wrap);

  card.append(header, body);
  return card;
}

function buildMermaidErrorCard(source: string, message: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "content-card content-card-code content-card-mermaid";

  const header = createCodeCardHeader({
    label: "Mermaid",
    icon: MermaidCardIcon,
  });

  const body = document.createElement("div");
  body.className = "content-card-mermaid-body";

  const error = document.createElement("p");
  error.className = "content-card-mermaid-status is-error";
  error.textContent = `Failed to render diagram: ${message}`;

  const pre = document.createElement("pre");
  pre.className = "content-card-mermaid-source";
  pre.textContent = source;

  body.append(error, pre);
  card.append(header, body);
  return card;
}

async function renderMermaidSvg(source: string): Promise<string> {
  ensureMermaidInitialized();
  renderSeq += 1;
  const id = `jb-mermaid-${renderSeq}-${Date.now()}`;
  const { svg } = await mermaid.render(id, source);
  return svg;
}

/**
 * Await Mermaid SVG (globally serial) and return a finished card.
 * Callers should wait before appending so the conversation stays ordered.
 */
export function renderMermaidCard(source: string): Promise<HTMLElement> {
  const trimmed = source.trim();
  const task = async (): Promise<HTMLElement> => {
    if (!trimmed) {
      return buildMermaidErrorCard(source, "Empty Mermaid diagram.");
    }
    try {
      const svg = await renderMermaidSvg(trimmed);
      return buildMermaidCard(source, svg);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return buildMermaidErrorCard(source, message);
    }
  };

  const run = mermaidQueue.then(task, task);
  mermaidQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}
