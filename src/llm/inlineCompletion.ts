/**
 * Pure helpers for Dev Mode ghost-text completion.
 * The model sees a short prefix/suffix window and must return only the
 * insertion. No I/O.
 */

export const INLINE_PREFIX_CHARS = 6_000;
export const INLINE_SUFFIX_CHARS = 1_500;
export const INLINE_MAX_LINES = 4;
export const INLINE_MAX_CHARS = 240;

const IDENT = /[A-Za-z0-9_]/;
const PROSE =
  /^(?:here(?:'s| is)\b|sure\b|certainly\b|the (?:completed|completion|code|following)\b|i(?:'|’)ll\b|let me\b)/i;

export function shouldRequestCompletion(prefix: string, suffix: string): boolean {
  if (prefix.trim().length < 2) return false;
  const left = prefix.at(-1) ?? "";
  const right = suffix[0] ?? "";
  // Cursor sits inside an identifier — a chat completion is the wrong tool.
  if (IDENT.test(left) && IDENT.test(right)) return false;
  return true;
}

/**
 * Cursor-centered window. The prefix is cut on a newline when one falls
 * inside the budget, so the model does not start mid-token.
 * Returns null when this caret should not call the model.
 */
export function sliceCompletionWindow(
  text: string,
  offset: number,
): { prefix: string; suffix: string } | null {
  const caret = Math.max(0, Math.min(offset, text.length));
  let prefix = text.slice(0, caret);
  let suffix = text.slice(caret);
  if (prefix.length > INLINE_PREFIX_CHARS) {
    const rough = prefix.length - INLINE_PREFIX_CHARS;
    const newline = prefix.indexOf("\n", rough);
    const cut = newline >= 0 && newline < prefix.length - 1 ? newline + 1 : rough;
    prefix = prefix.slice(cut);
  }
  if (suffix.length > INLINE_SUFFIX_CHARS) {
    const newline = suffix.lastIndexOf("\n", INLINE_SUFFIX_CHARS);
    suffix = suffix.slice(0, newline > 80 ? newline : INLINE_SUFFIX_CHARS);
  }
  if (!shouldRequestCompletion(prefix, suffix)) return null;
  return { prefix, suffix };
}

function oneLine(value: string, max: number): string {
  return value.replace(/[\r\n]+/g, " ").trim().slice(0, max);
}

export function buildInlineCompletionMessages(input: {
  languageId: string;
  fileName: string;
  prefix: string;
  suffix: string;
}): { role: "system" | "user"; content: string }[] {
  return [
    {
      role: "system",
      content: [
        "You are a code completion engine.",
        "Output only the code that should be inserted at the cursor.",
        "Do not repeat the prefix or the suffix.",
        "Do not add explanations, labels, or markdown fences.",
        "Finish the current line. At most a few lines.",
        "If nothing should be inserted, output an empty response.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Language: ${oneLine(input.languageId, 40) || "text"}`,
        `File: ${oneLine(input.fileName, 80) || "untitled"}`,
        "<prefix>",
        input.prefix,
        "<cursor>",
        "<suffix>",
        input.suffix,
        "</suffix>",
      ].join("\n"),
    },
  ];
}

function unwrapFence(text: string): string {
  let out = text.trim();
  if (!out.startsWith("```")) return out;
  out = out.replace(/^```[^\n]*\n?/, "");
  out = out.replace(/\n?```$/, "");
  return out.trim();
}

/** Longest prefix of `completion` that is also a suffix of `prefix` (min 3). */
function stripPrefixOverlap(prefix: string, completion: string): string {
  const tail = prefix.slice(-200);
  const max = Math.min(tail.length, completion.length);
  for (let size = max; size >= 3; size -= 1) {
    if (tail.endsWith(completion.slice(0, size))) return completion.slice(size);
  }
  return completion;
}

/** Drop a copied suffix, including a closing bracket the file already has. */
function stripSuffixOverlap(completion: string, suffix: string): string {
  const head = suffix.slice(0, 200);
  const max = Math.min(head.length, completion.length);
  for (let size = max; size >= 1; size -= 1) {
    const overlap = completion.slice(completion.length - size);
    if (!head.startsWith(overlap)) continue;
    if (size >= 3 || /^[\s)}\]"'`]+$/.test(overlap)) {
      return completion.slice(0, completion.length - size);
    }
  }
  return completion;
}

function looksLikeProse(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (PROSE.test(trimmed)) return true;
  const words = trimmed.split(/\s+/).length;
  return words >= 8 && !/[{}();=<>[\]]/.test(trimmed);
}

/**
 * Turn raw model text into the insertion, or null when it should not appear.
 * Mid-line carets stay on one line — Monaco rejects a multiline ghost text
 * whose replace range does not end at EOL.
 */
export function sanitizeInlineCompletion(
  raw: string,
  prefix: string,
  suffix: string,
): string | null {
  let text = unwrapFence(raw.replace(/\r\n/g, "\n"));
  text = text.replace(/<\/?(?:suffix|prefix)>|<cursor>/gi, "");
  text = stripPrefixOverlap(prefix, text);
  text = stripSuffixOverlap(text, suffix);
  if (prefix.endsWith("\n")) text = text.replace(/^\n/, "");
  if (looksLikeProse(text)) return null;

  const atLineEnd = suffix.length === 0 || suffix.startsWith("\n");
  if (!atLineEnd) text = text.split("\n")[0] ?? "";

  const blank = text.search(/\n[ \t]*\n/);
  if (blank >= 0) text = text.slice(0, blank);
  const lines = text.split("\n");
  if (lines.length > INLINE_MAX_LINES) text = lines.slice(0, INLINE_MAX_LINES).join("\n");
  if (text.length > INLINE_MAX_CHARS) text = text.slice(0, INLINE_MAX_CHARS);
  text = text.replace(/[ \t]+$/g, "").replace(/\n+$/g, "");
  if (!text.trim()) return null;
  if (suffix.startsWith(text)) return null;
  return text;
}
