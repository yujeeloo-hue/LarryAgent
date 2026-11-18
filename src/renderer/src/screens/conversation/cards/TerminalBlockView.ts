import {
  highlightCodeHtml,
  resolveHighlightLanguage,
} from "./codeHighlight.js";

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
