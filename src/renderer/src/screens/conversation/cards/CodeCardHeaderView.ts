import { createLucideIcon, type IconNode } from "../../../ui/originalIcons.js";
import { Check, Code, Copy, Image, SquareTerminal, Workflow } from "lucide";
import { isShellFenceLanguage } from "./TerminalBlockView.js";

const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Shell",
  sh: "Shell",
  shell: "Shell",
  zsh: "Shell",
  console: "Shell",
  terminal: "Shell",
  powershell: "PowerShell",
  ps1: "PowerShell",
  cmd: "Batch",
  bat: "Batch",
  ts: "TypeScript",
  tsx: "TypeScript",
  typescript: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  javascript: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  json: "JSON",
  css: "CSS",
  html: "HTML",
  htm: "HTML",
  xml: "XML",
  svg: "SVG",
  md: "Markdown",
  markdown: "Markdown",
  py: "Python",
  python: "Python",
  yml: "YAML",
  yaml: "YAML",
  diff: "Diff",
  patch: "Diff",
  sql: "SQL",
  go: "Go",
  rs: "Rust",
  rust: "Rust",
  java: "Java",
  swift: "Swift",
  kt: "Kotlin",
  rb: "Ruby",
  php: "PHP",
  c: "C",
  cpp: "C++",
  cs: "C#",
  toml: "TOML",
  ini: "INI",
  text: "Text",
  txt: "Text",
};

/** Human-readable title for a fence language tag (falls back to "Code"). */
export function codeFenceLabel(language?: string): string {
  const tag = (language ?? "").trim().toLowerCase();
  if (!tag) return "Code";
  return LANGUAGE_LABELS[tag] ?? tag.toUpperCase();
}

function iconForLanguage(language?: string): IconNode {
  if (isShellFenceLanguage(language)) return SquareTerminal;
  return Code;
}

export type CodeCardHeaderOptions = {
  /** Left-side title; defaults to a label derived from `language`. */
  label?: string;
  language?: string;
  icon?: IconNode;
  /** When set, a copy button is added on the right. */
  copyText?: string;
  copyAriaLabel?: string;
};

/**
 * Header row for code / diagram cards. Mirrors the tool invocation card's
 * summary row (icon + bold name left, actions right) so both read as one
 * family of cards.
 */
export function createCodeCardHeader(
  options: CodeCardHeaderOptions,
): HTMLElement {
  const header = document.createElement("div");
  header.className = "content-card-code-header";

  const left = document.createElement("div");
  left.className = "content-card-code-header-left";

  const icon = createLucideIcon(
    options.icon ?? iconForLanguage(options.language),
    { size: 15 },
  );
  icon.classList.add("content-card-code-icon");

  const label = options.label ?? codeFenceLabel(options.language);
  const name = document.createElement("span");
  name.className = "content-card-code-lang";
  name.textContent = label;
  name.title = label;

  left.append(icon, name);

  const right = document.createElement("div");
  right.className = "content-card-code-header-right";

  if (options.copyText !== undefined) {
    right.append(
      createCopyButton(options.copyText, options.copyAriaLabel ?? "Copy code"),
    );
  }

  header.append(left, right);
  return header;
}

function createCopyButton(text: string, ariaLabel: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "content-card-code-copy";
  btn.setAttribute("aria-label", ariaLabel);
  btn.title = "Copy";
  btn.append(createLucideIcon(Copy, { size: 14 }));

  btn.addEventListener("click", () => {
    void navigator.clipboard.writeText(text).then(() => {
      btn.replaceChildren(createLucideIcon(Check, { size: 14 }));
      window.setTimeout(() => {
        btn.replaceChildren(createLucideIcon(Copy, { size: 14 }));
      }, 1500);
    });
  });

  return btn;
}

export { Image as SvgCardIcon, Workflow as MermaidCardIcon };
