import type { DisplayBlock, InlineNode } from "../../../markdown/types.js";
import { createConversationImageElement } from "../../../markdown/conversationImage.js";
import { createCodeCardHeader } from "./CodeCardHeaderView.js";
import { createTerminalBlockView } from "./TerminalBlockView.js";
import {
  createMermaidStreamingPlaceholder,
  isMermaidFenceLanguage,
  renderMermaidCard,
} from "./MermaidBlockView.js";
import {
  renderSvgCard,
  shouldRenderSvgFence,
} from "./SvgBlockView.js";

export type RenderMarkdownBlocksOptions = {
  /** When true, Mermaid / SVG fences stay as placeholders (no preview render). */
  streaming?: boolean;
};

function appendInlines(parent: HTMLElement, nodes: InlineNode[]): void {
  for (const node of nodes) {
    switch (node.type) {
      case "text":
        parent.append(document.createTextNode(node.text));
        break;
      case "strong": {
        const el = document.createElement("strong");
        appendInlines(el, node.children);
        parent.append(el);
        break;
      }
      case "em": {
        const el = document.createElement("em");
        appendInlines(el, node.children);
        parent.append(el);
        break;
      }
      case "codespan": {
        const el = document.createElement("code");
        el.className = "md-codespan";
        el.textContent = node.text;
        parent.append(el);
        break;
      }
      case "link": {
        const el = document.createElement("a");
        el.className = "md-link";
        el.href = node.href;
        el.target = "_blank";
        el.rel = "noopener noreferrer";
        // Keep navigation out of the BrowserWindow (freeze / blank app).
        el.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          void window.jellybot?.openExternal?.(node.href);
        });
        appendInlines(el, node.children);
        parent.append(el);
        break;
      }
      case "image": {
        parent.append(
          createConversationImageElement({
            src: node.src,
            alt: node.alt,
            className: "conversation-image conversation-image-inline",
          }),
        );
        break;
      }
      case "br":
        parent.append(document.createElement("br"));
        break;
      case "del": {
        const el = document.createElement("del");
        appendInlines(el, node.children);
        parent.append(el);
        break;
      }
      default:
        break;
    }
  }
}

function renderParagraph(block: Extract<DisplayBlock, { kind: "paragraph" }>): HTMLElement {
  const p = document.createElement("p");
  p.className = "md-paragraph";
  appendInlines(p, block.children);
  return p;
}

function renderHeading(block: Extract<DisplayBlock, { kind: "heading" }>): HTMLElement {
  const el = document.createElement(`h${block.depth}`);
  el.className = `md-heading md-heading-${block.depth}`;
  appendInlines(el, block.children);
  return el;
}

function renderList(block: Extract<DisplayBlock, { kind: "list" }>): HTMLElement {
  const el = document.createElement(block.ordered ? "ol" : "ul");
  el.className = "md-list";
  for (const item of block.items) {
    const li = document.createElement("li");
    appendInlines(li, item.children);
    el.append(li);
  }
  return el;
}

function renderBlockquote(
  block: Extract<DisplayBlock, { kind: "blockquote" }>,
  options?: RenderMarkdownBlocksOptions,
): HTMLElement {
  const el = document.createElement("blockquote");
  el.className = "md-blockquote";
  for (const child of block.children) {
    el.append(renderBlock(child, options));
  }
  return el;
}

function renderTable(block: Extract<DisplayBlock, { kind: "table" }>): HTMLElement {
  const card = document.createElement("div");
  card.className = "content-card content-card-table";

  const scroll = document.createElement("div");
  scroll.className = "content-card-table-scroll";

  const table = document.createElement("table");
  table.className = "md-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  block.header.forEach((cell, i) => {
    const th = document.createElement("th");
    const align = block.align[i];
    if (align) th.style.textAlign = align;
    appendInlines(th, cell);
    headRow.append(th);
  });
  thead.append(headRow);
  table.append(thead);

  const tbody = document.createElement("tbody");
  for (const row of block.rows) {
    const tr = document.createElement("tr");
    row.forEach((cell, i) => {
      const td = document.createElement("td");
      const align = block.align[i];
      if (align) td.style.textAlign = align;
      appendInlines(td, cell);
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(tbody);
  scroll.append(table);
  card.append(scroll);
  return card;
}

function renderCode(
  block: Extract<DisplayBlock, { kind: "code" }>,
  options?: RenderMarkdownBlocksOptions,
): HTMLElement {
  if (isMermaidFenceLanguage(block.language)) {
    // Sync path (streaming / non-awaiting callers): status hint only.
    return createMermaidStreamingPlaceholder();
  }
  if (shouldRenderSvgFence(block.language, block.text)) {
    // Live preview while streaming; incomplete markup is balanced best-effort.
    return renderSvgCard(block.text, {
      streaming: options?.streaming === true,
    });
  }

  const card = document.createElement("div");
  card.className = "content-card content-card-code";

  const header = createCodeCardHeader({
    ...(block.language !== undefined ? { language: block.language } : {}),
    copyText: block.text,
  });

  card.append(header, createTerminalBlockView(block.text, block.language));
  return card;
}

function renderImage(block: Extract<DisplayBlock, { kind: "image" }>): HTMLElement {
  const figure = document.createElement("figure");
  figure.className = "md-image-figure";
  figure.append(
    createConversationImageElement({
      src: block.src,
      alt: block.alt,
      className: "conversation-image",
    }),
  );
  if (block.alt.trim()) {
    const caption = document.createElement("figcaption");
    caption.className = "md-image-caption";
    caption.textContent = block.alt;
    figure.append(caption);
  }
  return figure;
}

function renderBlock(
  block: DisplayBlock,
  options?: RenderMarkdownBlocksOptions,
): HTMLElement {
  switch (block.kind) {
    case "paragraph":
      return renderParagraph(block);
    case "heading":
      return renderHeading(block);
    case "list":
      return renderList(block);
    case "blockquote":
      return renderBlockquote(block, options);
    case "image":
      return renderImage(block);
    case "hr": {
      const hr = document.createElement("hr");
      hr.className = "md-hr";
      return hr;
    }
    case "table":
      return renderTable(block);
    case "code":
      return renderCode(block, options);
    default: {
      const fallback = document.createElement("div");
      return fallback;
    }
  }
}

/** Render Markdown display blocks into a container (prose + promoted cards). */
export function renderMarkdownBlocks(
  blocks: DisplayBlock[],
  container: HTMLElement,
  options?: RenderMarkdownBlocksOptions,
): void {
  container.classList.add("md-blocks");
  for (const block of blocks) {
    container.append(renderBlock(block, options));
  }
}

/**
 * Like {@link renderMarkdownBlocks}, but Mermaid fences await SVG serially
 * and only then append the finished card (conversation can wait on this).
 * Inline ```svg fences render sync (data-URL img).
 */
export async function renderMarkdownBlocksAsync(
  blocks: DisplayBlock[],
  container: HTMLElement,
  options?: RenderMarkdownBlocksOptions,
): Promise<void> {
  container.classList.add("md-blocks");
  if (options?.streaming === true) {
    for (const block of blocks) {
      container.append(renderBlock(block, options));
    }
    return;
  }

  for (const block of blocks) {
    if (block.kind === "code" && isMermaidFenceLanguage(block.language)) {
      container.append(await renderMermaidCard(block.text));
      continue;
    }
    if (
      block.kind === "code" &&
      shouldRenderSvgFence(block.language, block.text)
    ) {
      container.append(renderSvgCard(block.text));
      continue;
    }
    if (block.kind === "blockquote") {
      const el = document.createElement("blockquote");
      el.className = "md-blockquote";
      await renderMarkdownBlocksAsync(block.children, el, options);
      container.append(el);
      continue;
    }
    container.append(renderBlock(block, options));
  }
}
