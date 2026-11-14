import {
  highlightCodeHtml,
  resolveHighlightLanguage,
} from "./codeHighlight.js";

/** Shell / terminal fence languages — separate from lined source cards. */
export function isShellFenceLanguage(language?: string): boolean {
  if (!language) return false;
  switch (language.trim().toLowerCase()) {
    case "bash":
    case "shell":
    case "sh":
    case "zsh":
    case "console":
    case "terminal":
    case "powershell":
    case "ps1":
    case "cmd":
    case "bat":
      return true;
    default:
      return false;
  }
}

/**
 * Terminal command / shell output block: single pre/code, no line numbers,
 * no zebra rows — comfortable line-height for reading commands.
 *
 * Shell-language fences carry the `is-shell` marker: the Light theme paints
 * those frames as a pale recess (see content-cards-markdown.css) instead of
 * the dark code island, while source-code fences keep github-dark. Marking
 * happens here (not in CSS :has) because the language is only known at
 * build time; an untagged fence stays unmarked even though it highlights
 * as bash — its content may be anything.
 */
export function createTerminalBlockView(
  text: string,
  language?: string,
): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "content-card-terminal";
  if (isShellFenceLanguage(language)) pre.classList.add("is-shell");


  const code = document.createElement("code");
  code.className = "content-card-terminal-code hljs";

  const lang = resolveHighlightLanguage({
    ...(language !== undefined ? { language } : { language: "bash" }),
    content: text,
  });
  code.innerHTML = highlightCodeHtml(text.length > 0 ? text : " ", lang);

  pre.append(code);
  return pre;
}
