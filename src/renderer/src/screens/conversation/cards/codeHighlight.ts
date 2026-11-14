import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import cpp from "highlight.js/lib/languages/cpp";
import c from "highlight.js/lib/languages/c";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import "highlight.js/styles/github-dark.css";

let registered = false;

function ensureLanguages(): void {
  if (registered) return;
  hljs.registerLanguage("bash", bash);
  hljs.registerLanguage("shell", bash);
  hljs.registerLanguage("sh", bash);
  hljs.registerLanguage("c", c);
  hljs.registerLanguage("cpp", cpp);
  hljs.registerLanguage("csharp", csharp);
  hljs.registerLanguage("css", css);
  hljs.registerLanguage("diff", diff);
  hljs.registerLanguage("go", go);
  hljs.registerLanguage("ini", ini);
  hljs.registerLanguage("java", java);
  hljs.registerLanguage("javascript", javascript);
  hljs.registerLanguage("js", javascript);
  hljs.registerLanguage("json", json);
  hljs.registerLanguage("kotlin", kotlin);
  hljs.registerLanguage("lua", lua);
  hljs.registerLanguage("markdown", markdown);
  hljs.registerLanguage("md", markdown);
  hljs.registerLanguage("php", php);
  hljs.registerLanguage("python", python);
  hljs.registerLanguage("py", python);
  hljs.registerLanguage("ruby", ruby);
  hljs.registerLanguage("rust", rust);
  hljs.registerLanguage("sql", sql);
  hljs.registerLanguage("swift", swift);
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
  c: "c",
  h: "cpp",
  cc: "cpp",
  "c++": "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cs: "csharp",
  csx: "csharp",
  lua: "lua",
  swift: "swift",
  java: "java",
  go: "go",
  rs: "rust",
  kt: "kotlin",
  kts: "kotlin",
  php: "php",
  rb: "ruby",
  sql: "sql",
  db: "sql",
  ini: "ini",
  toml: "ini",
  conf: "ini",
  env: "ini",
  diff: "diff",
  patch: "diff",
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

/** Extract a path-like token from tool headlines such as `Wrote /a/b.ts (+1 −0)`. */
export function pathFromToolHeadline(headline: string): string | undefined {
  const match = headline.match(/(?:Wrote|Edited|Read)\s+(.+?)(?:\s+\(|$)/);
  const path = match?.[1]?.trim();
  return path && path.length > 0 ? path : undefined;
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
