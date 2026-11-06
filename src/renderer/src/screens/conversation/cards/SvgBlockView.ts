import { createCodeCardHeader, SvgCardIcon } from "./CodeCardHeaderView.js";

export function isSvgFenceLanguage(language?: string): boolean {
  const lang = (language ?? "").trim().toLowerCase();
  return lang === "svg" || lang === "image/svg+xml";
}

/** True when the fence body looks like an SVG document/fragment. */
export function looksLikeSvgSource(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // Allow optional XML declaration / doctype before the root <svg>.
  return /^(\s*<\?xml[\s\S]*?\?>)?(\s*<!DOCTYPE[\s\S]*?>)?\s*<svg\b/i.test(
    trimmed,
  );
}

export function shouldRenderSvgFence(
  language: string | undefined,
  text: string,
): boolean {
  return isSvgFenceLanguage(language) || looksLikeSvgSource(text);
}

export type RenderSvgCardOptions = {
  /** Best-effort preview while the fence is still streaming in. */
  streaming?: boolean;
};

function createPendingHint(): HTMLElement {
  const pending = document.createElement("p");
  pending.className = "md-paragraph content-card-svg-pending-hint";
  pending.textContent = "SVG will appear when ready…";
  return pending;
}

function extractCompleteSvgMarkup(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/<svg\b[\s\S]*<\/svg>/i);
  if (match?.[0]) return match[0];
  return null;
}

/**
 * Elements that are almost always empty / self-closing in LLM SVG output.
 * Still closed explicitly when truncated mid-stream without `/>`.
 */
const SVG_EMPTY_TAGS = new Set([
  "path",
  "circle",
  "ellipse",
  "line",
  "polygon",
  "polyline",
  "rect",
  "stop",
  "use",
  "image",
  "mpath",
  "view",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
]);

/**
 * Turn a truncated SVG fragment into something DOMParser can often accept:
 * drop a trailing half-tag, then close any still-open elements.
 */
function balanceIncompleteSvg(source: string): string | null {
  const trimmed = source.trim();
  const start = trimmed.search(/<svg\b/i);
  if (start < 0) return null;

  let body = trimmed.slice(start);
  // Drop a trailing incomplete start/end tag cut mid-attribute.
  body = body.replace(/<\/?[A-Za-z][^>]*$/u, "");
  if (!/<svg\b/i.test(body)) return null;

  if (/<\/svg>/i.test(body)) {
    return extractCompleteSvgMarkup(body) ?? body;
  }

  const openTags: string[] = [];
  const tagRe = /<\/?([A-Za-z][\w:-]*)\b[^>]*\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(body)) !== null) {
    const full = match[0];
    const name = match[1]!.toLowerCase();
    if (full.startsWith("</")) {
      for (let i = openTags.length - 1; i >= 0; i -= 1) {
        if (openTags[i] === name) {
          openTags.splice(i);
          break;
        }
      }
      continue;
    }
    const selfClosing = /\/>\s*$/.test(full) || SVG_EMPTY_TAGS.has(name);
    if (!selfClosing) {
      openTags.push(name);
    }
  }

  let closed = body;
  for (let i = openTags.length - 1; i >= 0; i -= 1) {
    closed += `</${openTags[i]}>`;
  }
  if (!/<\/svg>/i.test(closed)) {
    closed += "</svg>";
  }
  return closed;
}

function extractSvgMarkup(
  source: string,
  options?: { allowIncomplete?: boolean },
): string | null {
  const complete = extractCompleteSvgMarkup(source);
  if (complete) return complete;

  if (options?.allowIncomplete) {
    return balanceIncompleteSvg(source);
  }

  const trimmed = source.trim();
  if (
    /^(\s*<\?xml[\s\S]*?\?>)?(\s*<!DOCTYPE[\s\S]*?>)?\s*<svg\b/i.test(trimmed)
  ) {
    return trimmed;
  }
  return null;
}

/**
 * Parse + strip executable bits so LLM SVG can be inlined safely.
 * Returns a sanitized `<svg>` element ready to append.
 */
function sanitizeSvgElement(svgMarkup: string): SVGElement {
  const doc = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    throw new Error("Invalid SVG markup");
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") {
    throw new Error("No <svg> root found");
  }

  for (const el of Array.from(
    root.querySelectorAll("script, foreignObject, foreignobject"),
  )) {
    el.remove();
  }

  for (const el of Array.from(root.querySelectorAll("*"))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (name.startsWith("on") || value.startsWith("javascript:")) {
        el.removeAttribute(attr.name);
      }
    }
  }

  // Import into the host document so CSS / layout behave normally.
  return document.importNode(root, true) as unknown as SVGElement;
}

function buildSvgCard(
  source: string,
  svgMarkup: string,
  options?: { streaming?: boolean },
): HTMLElement {
  const card = document.createElement("div");
  card.className = [
    "content-card",
    "content-card-code",
    "content-card-svg",
    options?.streaming ? "is-streaming" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const header = createCodeCardHeader({
    label: options?.streaming ? "SVG · streaming" : "SVG",
    icon: SvgCardIcon,
    copyText: source,
    copyAriaLabel: "Copy SVG source",
  });

  const body = document.createElement("div");
  body.className = "content-card-svg-body";

  const wrap = document.createElement("div");
  wrap.className = "content-card-svg-preview";
  wrap.append(sanitizeSvgElement(svgMarkup));
  body.append(wrap);

  card.append(header, body);
  return card;
}

function buildSvgErrorCard(source: string, message: string): HTMLElement {
  const card = document.createElement("div");
  card.className = "content-card content-card-code content-card-svg";

  const header = createCodeCardHeader({ label: "SVG", icon: SvgCardIcon });

  const body = document.createElement("div");
  body.className = "content-card-svg-body";

  const error = document.createElement("p");
  error.className = "content-card-svg-status is-error";
  error.textContent = `Failed to render SVG: ${message}`;

  const pre = document.createElement("pre");
  pre.className = "content-card-svg-source";
  pre.textContent = source;

  body.append(error, pre);
  card.append(header, body);
  return card;
}

/**
 * Build an SVG preview card. With `{ streaming: true }`, incomplete markup is
 * auto-balanced for a live preview; parse failures reuse the last good frame
 * when possible so the preview does not flicker back to a placeholder.
 */
const lastGoodStreamingMarkup = new Map<string, string>();
const LAST_GOOD_STREAMING_LIMIT = 8;

function streamingOpenTagKey(source: string): string | null {
  const match = source.match(/<svg\b[^>\n]*>/i);
  return match?.[0] ?? null;
}

function rememberStreamingMarkup(source: string, markup: string): void {
  const key = streamingOpenTagKey(source) ?? streamingOpenTagKey(markup);
  if (!key) return;
  if (
    lastGoodStreamingMarkup.size >= LAST_GOOD_STREAMING_LIMIT &&
    !lastGoodStreamingMarkup.has(key)
  ) {
    const first = lastGoodStreamingMarkup.keys().next().value;
    if (first) lastGoodStreamingMarkup.delete(first);
  }
  lastGoodStreamingMarkup.set(key, markup);
}

function lastStreamingMarkup(source: string): string | null {
  const key = streamingOpenTagKey(source);
  if (!key) return null;
  return lastGoodStreamingMarkup.get(key) ?? null;
}

export function renderSvgCard(
  source: string,
  options?: RenderSvgCardOptions,
): HTMLElement {
  const streaming = options?.streaming === true;
  const markup = extractSvgMarkup(source, { allowIncomplete: streaming });
  if (!markup) {
    if (streaming) {
      const prev = lastStreamingMarkup(source);
      if (prev) {
        try {
          return buildSvgCard(source, prev, { streaming: true });
        } catch {
          // fall through to pending hint
        }
      }
      return createPendingHint();
    }
    return buildSvgErrorCard(source, "No <svg> root found.");
  }
  try {
    const card = buildSvgCard(source, markup, { streaming });
    if (streaming) rememberStreamingMarkup(source, markup);
    return card;
  } catch (err) {
    if (streaming) {
      const prev = lastStreamingMarkup(source);
      if (prev) {
        try {
          return buildSvgCard(source, prev, { streaming: true });
        } catch {
          // fall through
        }
      }
      return createPendingHint();
    }
    const message = err instanceof Error ? err.message : String(err);
    return buildSvgErrorCard(source, message);
  }
}
