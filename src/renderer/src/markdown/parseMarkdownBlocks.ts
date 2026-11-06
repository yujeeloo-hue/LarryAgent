import { marked, type Token, type Tokens } from "marked";
import { resolveMarkdownImageSrc } from "./conversationImage.js";
import type { DisplayBlock, InlineNode } from "./types.js";

marked.setOptions({ gfm: true, breaks: false });

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
        if (t.tokens && t.tokens.length > 0) {
          out.push(...mapInlineTokens(t.tokens));
        } else {
          out.push({ type: "text", text: t.text });
        }
        break;
      }
      case "escape": {
        const t = token as Tokens.Escape;
        out.push({ type: "text", text: t.text });
        break;
      }
      case "strong": {
        const t = token as Tokens.Strong;
        out.push({ type: "strong", children: mapInlineTokens(t.tokens) });
        break;
      }
      case "em": {
        const t = token as Tokens.Em;
        out.push({ type: "em", children: mapInlineTokens(t.tokens) });
        break;
      }
      case "codespan": {
        const t = token as Tokens.Codespan;
        out.push({ type: "codespan", text: t.text });
        break;
      }
      case "link": {
        const t = token as Tokens.Link;
        if (isSafeHref(t.href)) {
          out.push({
            type: "link",
            href: t.href,
            children: mapInlineTokens(t.tokens),
          });
        } else {
          out.push(...mapInlineTokens(t.tokens));
        }
        break;
      }
      case "image": {
        const t = token as Tokens.Image;
        const src = resolveMarkdownImageSrc(t.href);
        if (src) {
          out.push({ type: "image", src, alt: t.text ?? "" });
        } else {
          const label = t.text?.trim() || t.href;
          out.push({ type: "text", text: label ? `[${label}]` : "" });
        }
        break;
      }
      case "br":
        out.push({ type: "br" });
        break;
      case "del": {
        const t = token as Tokens.Del;
        out.push({ type: "del", children: mapInlineTokens(t.tokens) });
        break;
      }
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
  if (cell.tokens && cell.tokens.length > 0) {
    return mapInlineTokens(cell.tokens);
  }
  return cell.text ? [{ type: "text", text: cell.text }] : [];
}

function mapAlign(
  value: string | null | undefined,
): "left" | "center" | "right" | null {
  if (value === "left" || value === "center" || value === "right") return value;
  return null;
}

function listItemInlines(item: Tokens.ListItem): InlineNode[] {
  const tokens = item.tokens ?? [];
  const inlines: InlineNode[] = [];
  for (const token of tokens) {
    if (token.type === "paragraph" || token.type === "text") {
      const t = token as Tokens.Paragraph | Tokens.Text;
      inlines.push(...mapInlineTokens(t.tokens ?? undefined));
      if (
        (!t.tokens || t.tokens.length === 0) &&
        "text" in t &&
        typeof t.text === "string"
      ) {
        inlines.push({ type: "text", text: t.text });
      }
    } else if (token.type === "space") {
      // skip
    } else if ("text" in token && typeof (token as { text: string }).text === "string") {
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
      case "paragraph": {
        const t = token as Tokens.Paragraph;
        blocks.push({
          kind: "paragraph",
          children: mapInlineTokens(t.tokens),
        });
        break;
      }
      case "heading": {
        const t = token as Tokens.Heading;
        const depth = Math.min(6, Math.max(1, t.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
        blocks.push({
          kind: "heading",
          depth,
          children: mapInlineTokens(t.tokens),
        });
        break;
      }
      case "list": {
        const t = token as Tokens.List;
        blocks.push({
          kind: "list",
          ordered: Boolean(t.ordered),
          items: (t.items ?? []).map((item) => ({
            children: listItemInlines(item),
          })),
        });
        break;
      }
      case "blockquote": {
        const t = token as Tokens.Blockquote;
        blocks.push({
          kind: "blockquote",
          children: mapBlockTokens(t.tokens ?? []),
        });
        break;
      }
      case "hr":
        blocks.push({ kind: "hr" });
        break;
      case "image": {
        const t = token as Tokens.Image;
        const src = resolveMarkdownImageSrc(t.href);
        if (src) {
          blocks.push({ kind: "image", src, alt: t.text ?? "" });
        } else {
          const label = t.text?.trim() || t.href;
          blocks.push({
            kind: "paragraph",
            children: [{ type: "text", text: label ? `[${label}]` : "" }],
          });
        }
        break;
      }
      case "code": {
        const t = token as Tokens.Code;
        blocks.push({
          kind: "code",
          language: (t.lang ?? "").trim(),
          text: t.text,
        });
        break;
      }
      case "table": {
        const t = token as Tokens.Table;
        blocks.push({
          kind: "table",
          header: (t.header ?? []).map(cellInlines),
          rows: (t.rows ?? []).map((row) => row.map(cellInlines)),
          align: (t.align ?? []).map(mapAlign),
        });
        break;
      }
      case "html": {
        const t = token as Tokens.HTML;
        if (t.text.trim()) {
          blocks.push({
            kind: "paragraph",
            children: [{ type: "text", text: t.text }],
          });
        }
        break;
      }
      default:
        if ("raw" in token && typeof (token as { raw: string }).raw === "string") {
          const raw = (token as { raw: string }).raw.trim();
          if (raw) {
            blocks.push({
              kind: "paragraph",
              children: [{ type: "text", text: raw }],
            });
          }
        }
        break;
    }
  }
  return blocks;
}

/** Parse Markdown into view-only display blocks (Option C hybrid). */
export function parseMarkdownBlocks(markdown: string): DisplayBlock[] {
  if (!markdown) return [];
  const tokens = marked.lexer(markdown);
  return mapBlockTokens(tokens);
}
