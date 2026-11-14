/**
 * Syntax highlighting — verbatim port of the Mac app's codeHighlight.ts
 * (highlight.js core + on-demand languages, github-dark tokens).
 * Difference: the github-dark stylesheet is NOT imported here (keeps this
 * module JS-only so node:test/linkedom can load it); style.css @imports it.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

let registered = false;

function ensureLanguages(): void {
  if (registered) return;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("shell", bash);
  hljs.registerLanguage("sh", bash);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("js", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("md", markdown);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("py", python);
  hljs.registerLanguage("typescript", typescript);
  hljs.registerLanguage("ts", typescript);
  hljs.registerLanguage("tsx", typescript);
  hljs.registerLanguage("jsx", javascript);
  hljs.registerLanguage("xml", xml);
  hljs.registerLanguage("html", xml);
  hljs.registerLanguage("svg", xml);
  hljs.registerLanguage("yaml", yaml);
  hljs.registerLanguage("yml", yaml);
  registered = true;
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  html: "html",
  htm: "html",
  svg: "xml",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  xml: "xml",
};

/** Infer highlight.js language from a file path or fence language tag. */
export function languageFromPathOrName(pathOrName: string): string | undefined {
  const base = pathOrName.split(/[/\\]/).pop() ?? pathOrName;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return EXT_TO_LANG[ext];
}

/** True when the path should render as Markdown rather than lined source. */
export function isMarkdownPathOrName(pathOrName: string | undefined): boolean {
  if (!pathOrName) return false;
  const base = pathOrName.split(/[/\\]/).pop() ?? pathOrName;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return ext === "md" || ext === "markdown" || ext === "mdx";
}

/**
 * Best-effort language when path is missing or still streaming in
 * (e.g. write_file preview before `path` is known).
 */
export function sniffLanguageFromContent(text: string): string | undefined {
  const head = text.slice(0, 400).trimStart();
  if (!head) return undefined;
  const lower = head.toLowerCase();
  if (
    lower.startsWith("<!doctype") ||
    lower.startsWith("<html") ||
    lower.startsWith("<!--") ||
    /^<[a-z][\s>]/.test(lower)
  ) {
    return "html";
  }
  if (lower.startsWith("<?xml")) return "xml";
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  if (
    /^import\s+|export\s+|from\s+['"]|:\s*[A-Z]/.test(head) ||
    head.includes("interface ") ||
    head.includes("type ")
  ) {
    return "typescript";
  }
  if (
    /^(def |class |from |import )/.test(head) ||
    head.startsWith("#!/usr/bin/env python")
  ) {
    return "python";
  }
  if (
    head.startsWith("#!/bin/") ||
    /^(#!\/bin\/|#!\/usr\/bin\/env bash)/.test(head)
  ) {
    return "bash";
  }
  return undefined;
}

/** Resolve language from path first, then content sniff. */
export function resolveHighlightLanguage(options?: {
  pathOrName?: string;
  language?: string;
  content?: string;
}): string | undefined {
  if (options?.language) return options.language;
  if (options?.pathOrName) {
    const fromPath = languageFromPathOrName(options.pathOrName);
    if (fromPath) return fromPath;
  }
  if (options?.content) return sniffLanguageFromContent(options.content);
  return undefined;
}



/**
 * Highlight source into an HTML string (span tokens only — no wrapper).
 * Falls back to escaped plain text.
 */
export function highlightCodeHtml(code: string, language?: string): string {
  ensureLanguages();
  const escaped = escapeHtml(code);
  if (!language) return escaped;
  try {
    if (hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    }
  } catch {
    // fall through
  }
  return escaped;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
