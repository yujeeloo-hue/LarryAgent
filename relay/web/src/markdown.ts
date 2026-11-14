/**
 * Markdown pipeline — ported from the Mac app (src/renderer/src/markdown +
 * screens/conversation/cards/MarkdownBlocksView.ts) so the console renders
 * prose exactly like the desktop conversation. Mermaid / SVG previews and
 * IPC-backed attachment images are dropped; code fences keep the card look
 * with a single terminal body (Mac TerminalBlockView parity).
 */
import { marked, type Token, type Tokens } from "marked";
import { highlightCodeHtml, resolveHighlightLanguage } from "./codeHighlight.js";
import { icon } from "./icons.js";
import { el } from "./render.js";

marked.setOptions({ gfm: true, breaks: false });

export type InlineNode =
  | { type: "text"; text: string }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] }
  | { type: "codespan"; text: string }
  | { type: "link"; href: string; children: InlineNode[] }
  | { type: "br" }
  | { type: "del"; children: InlineNode[] };

export type DisplayBlock =
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "heading"; depth: 1 | 2 | 3 | 4 | 5 | 6; children: InlineNode[] }
  | { kind: "list"; ordered: boolean; items: Array<{ children: InlineNode[] }> }
  | { kind: "blockquote"; children: DisplayBlock[] }
  | { kind: "hr" }
  | {
      kind: "table";
      header: InlineNode[][];
      rows: InlineNode[][][];
      align: Array<"left" | "center" | "right" | null>;
    }
  | { kind: "code"; language: string; text: string };

function isSafeHref(href: string): boolean {
  try {
    const url = new URL(href, "https://example.invalid");
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function mapInlineTokens(tokens: Token[] | undefined): InlineNode[] {
  if (!tokens || tokens.length === 0) return [];
  const out: InlineNode[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        if (t.tokens && t.tokens.length > 0) out.push(...mapInlineTokens(t.tokens));
        else out.push({ type: "text", text: t.text });
        break;
      }
      case "escape":
        out.push({ type: "text", text: (token as Tokens.Escape).text });
        break;
      case "strong":
        out.push({ type: "strong", children: mapInlineTokens((token as Tokens.Strong).tokens) });
        break;
      case "em":
        out.push({ type: "em", children: mapInlineTokens((token as Tokens.Em).tokens) });
        break;
      case "codespan":
        out.push({ type: "codespan", text: (token as Tokens.Codespan).text });
        break;
      case "link": {
        const t = token as Tokens.Link;
        if (isSafeHref(t.href)) {
          out.push({ type: "link", href: t.href, children: mapInlineTokens(t.tokens) });
        } else {
          out.push(...mapInlineTokens(t.tokens));
        }
        break;
      }
      case "br":
        out.push({ type: "br" });
        break;
      case "del":
        out.push({ type: "del", children: mapInlineTokens((token as Tokens.Del).tokens) });
        break;
      default:
        if ("text" in token && typeof (token as { text?: unknown }).text === "string") {
          out.push({ type: "text", text: (token as { text: string }).text });
        }
        break;
    }
  }
  return out;
}

function cellInlines(cell: Tokens.TableCell): InlineNode[] {
  if (cell.tokens && cell.tokens.length > 0) return mapInlineTokens(cell.tokens);
  return cell.text ? [{ type: "text", text: cell.text }] : [];
}

function listItemInlines(item: Tokens.ListItem): InlineNode[] {
  const inlines: InlineNode[] = [];
  for (const token of item.tokens ?? []) {
    if (token.type === "paragraph" || token.type === "text") {
      const t = token as Tokens.Paragraph | Tokens.Text;
      inlines.push(...mapInlineTokens(t.tokens ?? undefined));
      if ((!t.tokens || t.tokens.length === 0) && typeof t.text === "string") {
        inlines.push({ type: "text", text: t.text });
      }
    } else if (token.type !== "space" && "text" in token && typeof (token as { text?: unknown }).text === "string") {
      inlines.push({ type: "text", text: (token as { text: string }).text });
    }
  }
  return inlines;
}

function mapBlockTokens(tokens: Token[]): DisplayBlock[] {
  const blocks: DisplayBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "paragraph":
        blocks.push({ kind: "paragraph", children: mapInlineTokens((token as Tokens.Paragraph).tokens) });
        break;
      case "heading": {
        const t = token as Tokens.Heading;
        const depth = Math.min(6, Math.max(1, t.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
        blocks.push({ kind: "heading", depth, children: mapInlineTokens(t.tokens) });
        break;
      }
      case "list": {
        const t = token as Tokens.List;
        blocks.push({
          kind: "list",
          ordered: Boolean(t.ordered),
          items: (t.items ?? []).map((item) => ({ children: listItemInlines(item) })),
        });
        break;
      }
      case "blockquote":
        blocks.push({ kind: "blockquote", children: mapBlockTokens((token as Tokens.Blockquote).tokens ?? []) });
        break;
      case "hr":
        blocks.push({ kind: "hr" });
        break;
      case "code": {
        const t = token as Tokens.Code;
        blocks.push({ kind: "code", language: (t.lang ?? "").trim(), text: t.text });
        break;
      }
      case "table": {
        const t = token as Tokens.Table;
        blocks.push({
          kind: "table",
          header: (t.header ?? []).map(cellInlines),
          rows: (t.rows ?? []).map((row) => row.map(cellInlines)),
          align: (t.align ?? []).map((v) => (v === "left" || v === "center" || v === "right" ? v : null)),
        });
        break;
      }
      case "html":
        if ((token as Tokens.HTML).text.trim()) {
          blocks.push({ kind: "paragraph", children: [{ type: "text", text: (token as Tokens.HTML).text }] });
        }
        break;
      default:
        if ("raw" in token && typeof (token as { raw: string }).raw === "string") {
          const raw = (token as { raw: string }).raw.trim();
          if (raw) blocks.push({ kind: "paragraph", children: [{ type: "text", text: raw }] });
        }
        break;
    }
  }
  return blocks;
}

/** Parse Markdown into view-only display blocks (same as the Mac app). */
export function parseMarkdownBlocks(markdown: string): DisplayBlock[] {
  if (!markdown) return [];
  return mapBlockTokens(marked.lexer(markdown));
}

function appendInlines(parent: HTMLElement, nodes: InlineNode[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        parent.append(document.createTextNode(node.text));
        break;
      case "strong": {
        const s = document.createElement("strong");
        appendInlines(s, node.children);
        parent.append(s);
        break;
      }
      case "em": {
        const s = document.createElement("em");
        appendInlines(s, node.children);
        parent.append(s);
        break;
      }
      case "codespan": {
        parent.append(el("code", { class: "md-codespan" }, node.text));
        break;
      }
      case "link": {
        const a = el("a", { class: "md-link", href: node.href, target: "_blank", rel: "noopener noreferrer" });
        appendInlines(a, node.children);
        parent.append(a);
        break;
      }
      case "br":
        parent.append(document.createElement("br"));
        break;
      case "del": {
        const s = document.createElement("del");
        appendInlines(s, node.children);
        parent.append(s);
        break;
      }
    }
  }
}

function renderTable(block: Extract<DisplayBlock, { kind: "table" }>): HTMLElement {
  const thead = el("thead");
  const headRow = el("tr");
  block.header.forEach((cell, i) => {
    const th = el("th");
    const align = block.align[i];
    if (align) th.style.textAlign = align;
    appendInlines(th, cell);
    headRow.append(th);
  });
  thead.append(headRow);
  const tbody = el("tbody");
  for (const row of block.rows) {
    const tr = el("tr");
    row.forEach((cell, i) => {
      const td = el("td");
      const align = block.align[i];
      if (align) td.style.textAlign = align;
      appendInlines(td, cell);
      tr.append(td);
    });
    tbody.append(tr);
  }
  return el("div", { class: "content-card content-card-table" },
    el("div", { class: "md-table-scroll" }, el("table", { class: "md-table" }, thead, tbody)));
}

/**
 * Shell fence languages — mirror of the client's isShellFenceLanguage
 * (TerminalBlockView.ts). Untagged fences are NOT shell: they only
 * default to bash *highlighting*; their content may be anything.
 */
const SHELL_FENCE_LANGUAGES = new Set([
  "bash",
  "shell",
  "sh",
  "zsh",
  "console",
  "terminal",
  "powershell",
  "ps1",
  "cmd",
  "bat",
]);

function renderCode(block: Extract<DisplayBlock, { kind: "code" }>): HTMLElement {
  // Mac parity (TerminalBlockView): single pre/code, whole-block highlight,
  // no line numbers; bash when the fence tag is missing. Shell-language
  // fences carry the is-shell marker so the Light theme paints them as a
  // pale recess instead of the dark code island (Mac parity; untagged
  // fences stay unmarked).
  const isShell = SHELL_FENCE_LANGUAGES.has(block.language.trim().toLowerCase());
  const pre = el("pre", {
    class: `content-card-terminal${isShell ? " is-shell" : ""}`,
  });
  const code = el("code", { class: "content-card-terminal-code hljs" });
  const language = resolveHighlightLanguage({
    ...(block.language ? { language: block.language } : { language: "bash" }),
    content: block.text,
  });
  code.innerHTML = highlightCodeHtml(
    block.text.length > 0 ? block.text : " ",
    language,
  );
  pre.append(code);
  return el("div", { class: "content-card content-card-code" },
    el("div", { class: "content-card-code-header" },
      el("div", { class: "content-card-code-header-left" },
        el("span", { class: "content-card-code-icon" }, icon("code", 14)),
        el("span", { class: "content-card-code-lang" }, block.language || "text"),
      ),
    ),
    el("div", { class: "content-card-code-lines" }, pre),
  );
}

function renderBlock(block: DisplayBlock): HTMLElement {
  switch (block.kind) {
    case "paragraph": {
      const p = el("p", { class: "md-paragraph" });
      appendInlines(p, block.children);
      return p;
    }
    case "heading": {
      const h = el(`h${block.depth}` as "h1", { class: `md-heading md-heading-${block.depth}` });
      appendInlines(h, block.children);
      return h;
    }
    case "list": {
      const list = el(block.ordered ? "ol" : "ul", { class: "md-list" });
      for (const item of block.items) {
        const li = el("li");
        appendInlines(li, item.children);
        list.append(li);
      }
      return list;
    }
    case "blockquote": {
      const q = el("blockquote", { class: "md-blockquote" });
      for (const child of block.children) q.append(renderBlock(child));
      return q;
    }
    case "hr":
      return el("hr", { class: "md-hr" });
    case "table":
      return renderTable(block);
    case "code":
      return renderCode(block);
  }
}

/** Render Markdown display blocks into a container (prose + promoted cards). */
export function renderMarkdownBlocks(blocks: DisplayBlock[], container: HTMLElement): void {
  container.classList.add("md-blocks");
  for (const block of blocks) container.append(renderBlock(block));
}


