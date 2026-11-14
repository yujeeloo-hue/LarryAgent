import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

export type PrintHtmlToPdfOptions = {
  /**
   * Absolute path to an HTML file on disk (preferred for relative CSS/images).
   * Mutually exclusive with {@link html}.
   */
  htmlFilePath?: string;
  /** Full HTML document string. Mutually exclusive with {@link htmlFilePath}. */
  html?: string;
  /**
   * When using {@link html}, optional base directory for relative assets.
   * A temporary HTML file is written under this directory (or os.tmpdir).
   */
  assetBaseDir?: string;
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// Electron access (lazy)
//
// The desktop app has Electron; headless nodes (jellybot-agentd) do not —
// printHtmlToPdf throws a descriptive error there and the convert_to_pdf tool
// is not registered (platformCaps.htmlToPdfEnabled). Dynamic-only import:
// keeps `electron` out of the static graph (build-agentd.mjs guard).
// ---------------------------------------------------------------------------

/** Structural subset of electron's BrowserWindow this module relies on. */
interface PdfBrowserWindow {
  webContents: {
    executeJavaScript(code: string): Promise<unknown>;
    loadURL(url: string): Promise<void>;
    printToPDF(options: {
      printBackground: boolean;
      landscape: boolean;
      pageSize: string;
    }): Promise<Buffer>;
  };
  isDestroyed(): boolean;
  destroy(): void;
}

interface PdfElectron {
  app?: { getAppPath(): string };
  BrowserWindow: new (options: Record<string, unknown>) => PdfBrowserWindow;
}

let electronPromise: Promise<PdfElectron | null> | null = null;

function loadElectron(): Promise<PdfElectron | null> {
  electronPromise ??= (async () => {
    try {
      const mod = (await import("electron")) as Partial<PdfElectron>;
      if (typeof mod?.BrowserWindow !== "function") return null;
      return mod as PdfElectron;
    } catch {
      return null;
    }
  })();
  return electronPromise;
}

function abortError(): Error {
  const err = new Error("Cancelled");
  err.name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function resolveMermaidMinJsPath(
  appModule: PdfElectron["app"] | undefined,
): string | null {
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve("mermaid/dist/mermaid.min.js");
    if (existsSync(resolved)) return resolved;
  } catch {
    // fall through
  }
  try {
    if (!appModule) return null;
    const fromApp = join(
      appModule.getAppPath(),
      "node_modules/mermaid/dist/mermaid.min.js",
    );
    if (existsSync(fromApp)) return fromApp;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Normalize language-mermaid code blocks and run Mermaid before print.
 * Failures are logged and ignored so PDF conversion still succeeds.
 */
async function renderMermaidInWindow(
  electron: PdfElectron,
  win: PdfBrowserWindow,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const mermaidPath = resolveMermaidMinJsPath(electron.app);
  if (!mermaidPath) {
    console.warn("[pdf] mermaid.min.js not found; skipping diagram render");
    return;
  }

  try {
    const countBefore = await win.webContents.executeJavaScript(
      `(() => {
        const codes = Array.from(
          document.querySelectorAll("code.language-mermaid, code.lang-mermaid"),
        );
        for (const code of codes) {
          const pre = code.closest("pre") || code.parentElement;
          const host = document.createElement("pre");
          host.className = "mermaid";
          host.textContent = code.textContent || "";
          if (pre && pre.parentNode) {
            pre.parentNode.replaceChild(host, pre);
          } else if (code.parentNode) {
            code.parentNode.replaceChild(host, code);
          }
        }
        return document.querySelectorAll(".mermaid").length;
      })()`,
    );
    throwIfAborted(signal);
    if (!countBefore || Number(countBefore) === 0) return;

    const mermaidSrc = await readFile(mermaidPath, "utf8");
    throwIfAborted(signal);

    // Inject library source (avoids file:// script load under sandbox).
    await win.webContents.executeJavaScript(mermaidSrc);
    throwIfAborted(signal);

    await win.webContents.executeJavaScript(
      `(async () => {
        if (!window.mermaid) {
          throw new Error("mermaid global missing after inject");
        }
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
        });
        await window.mermaid.run({ querySelector: ".mermaid" });
      })()`,
    );
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      "name" in err &&
      (err as { name: string }).name === "AbortError"
    ) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.warn("[pdf] mermaid render skipped:", message);
  }
}

/**
 * Render HTML in a hidden BrowserWindow and print to a PDF buffer.
 * Prefers loading from a real `file://` path so relative assets resolve.
 * Throws on headless nodes (no browser engine).
 */
export async function printHtmlToPdf(
  options: PrintHtmlToPdfOptions,
): Promise<Buffer> {
  throwIfAborted(options.signal);

  const electron = await loadElectron();
  if (!electron) {
    throw new Error(
      "HTML→PDF conversion requires the desktop app — no browser engine in the headless node",
    );
  }

  let tempDir: string | null = null;
  let loadPath: string;

  if (options.htmlFilePath) {
    loadPath = options.htmlFilePath;
  } else if (options.html !== undefined) {
    const parent = options.assetBaseDir?.trim() || tmpdir();
    tempDir = await mkdtemp(join(parent, ".jellybot-pdf-"));
    loadPath = join(tempDir, "document.html");
    await writeFile(loadPath, options.html, "utf8");
  } else {
    throw new Error("printHtmlToPdf requires htmlFilePath or html");
  }

  const win = new electron.BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
    },
  });

  const onAbort = (): void => {
    if (!win.isDestroyed()) win.destroy();
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    throwIfAborted(options.signal);
    await win.webContents.loadURL(pathToFileURL(loadPath).href);
    throwIfAborted(options.signal);

    await renderMermaidInWindow(electron, win, options.signal);
    throwIfAborted(options.signal);

    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      landscape: false,
      pageSize: "A4",
    });
    throwIfAborted(options.signal);
    return Buffer.from(pdf);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (!win.isDestroyed()) win.destroy();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const PRINT_CSS = `
@page { size: A4; margin: 16mm 14mm; }
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.5;
  color: #1a1a1a;
  margin: 0;
  padding: 0;
}
h1, h2, h3, h4, h5, h6 { page-break-after: avoid; }
pre, code {
  font-family: SFMono-Regular, Menlo, Consolas, ui-monospace, Monaco, monospace;
  font-size: 0.92em;
}
pre {
  overflow-x: auto;
  padding: 10px 12px;
  border: 1px solid #ddd;
  border-radius: 6px;
  background: #f6f8fa;
  white-space: pre-wrap;
  word-break: break-word;
}
pre.mermaid {
  background: transparent;
  border: none;
  padding: 8px 0;
  text-align: center;
}
pre.mermaid svg {
  max-width: 100%;
  height: auto;
}
img { max-width: 100%; height: auto; }
table { border-collapse: collapse; width: 100%; }
th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
blockquote {
  margin: 0.8em 0;
  padding: 0 0.8em;
  border-left: 3px solid #ccc;
  color: #444;
}
`;

/**
 * Convert marked's default mermaid fences (`pre > code.language-mermaid`)
 * into `<pre class="mermaid">` for client-side mermaid.run().
 */
export function promoteMermaidCodeBlocks(html: string): string {
  return html.replace(
    /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/gi,
    (_m, inner: string) => {
      // marked already HTML-escapes code text; keep as-is inside pre.mermaid.
      return `<pre class="mermaid">${inner}</pre>`;
    },
  );
}

/** Wrap Markdown-rendered HTML body in a printable document. */
export function wrapMarkdownHtmlDocument(bodyHtml: string): string {
  const body = promoteMermaidCodeBlocks(bodyHtml);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<style>${PRINT_CSS}</style>
</head>
<body>
${body}
</body>
</html>
`;
}
