import type { editor } from "monaco-editor";
import { signatureFunctionName } from "./compactLanguagePopover.js";

/** Small presentation hooks; Monaco still owns positioning, focus and keyboard input. */
export class CompactLanguagePopoverView {
  private readonly observer: MutationObserver;
  private readonly resizeObserver: ResizeObserver | null;

  constructor(
    private readonly host: HTMLElement,
    private readonly codeEditor: Pick<editor.IStandaloneCodeEditor, "getContribution" | "layoutContentWidget">,
  ) {
    this.observer = new MutationObserver((records) => {
      if (records.some((record) => {
        if (record.type !== "childList" && record.type !== "characterData") return false;
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        return target?.closest(".monaco-hover, .parameter-hints-widget") || Array.from(record.addedNodes).some((node) =>
          node instanceof Element ? (node.matches(".monaco-hover, .parameter-hints-widget") || node.querySelector(".monaco-hover, .parameter-hints-widget")) : node.parentElement?.closest(".monaco-hover, .parameter-hints-widget"));
      })) this.refresh();
    });
    this.observer.observe(host, { childList: true, subtree: true, characterData: true });
    const updateWidth = () => host.style.setProperty("--devmode-popover-max-width", `${Math.max(160, host.clientWidth - 24)}px`);
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateWidth);
    this.resizeObserver?.observe(host);
    updateWidth();
    host.addEventListener("toggle", this.onToggle, true);
    host.addEventListener("click", this.onCopy, true);
    host.addEventListener("keydown", this.onCopyKey, true);
    this.refresh();
  }

  destroy(): void {
    this.observer.disconnect();
    this.resizeObserver?.disconnect();
    this.host.removeEventListener("toggle", this.onToggle, true);
    this.host.removeEventListener("click", this.onCopy, true);
    this.host.removeEventListener("keydown", this.onCopyKey, true);
  }

  private refresh(): void {
    let hoverChanged = false;
    for (const hover of this.host.querySelectorAll<HTMLElement>(".monaco-hover")) {
      // Our generated h4 distinguishes symbol hovers from diagnostics and blame.
      if (!hover.querySelector(".markdown-hover h4")) {
        hover.classList.remove("devmode-symbol-hover");
        continue;
      }
      if (!hover.classList.contains("devmode-symbol-hover")) {
        hover.classList.add("devmode-symbol-hover");
        hoverChanged = true;
      }
      hover.querySelector(".hover-copy-button")?.setAttribute("aria-label", "Copy signature");
    }
    for (const hints of this.host.querySelectorAll<HTMLElement>(".parameter-hints-widget")) {
      const signature = hints.querySelector<HTMLElement>(".signature");
      const code = signature?.querySelector(".code");
      if (!signature || !code) continue;
      let title = hints.querySelector<HTMLElement>(".devmode-parameter-title");
      if (!title) {
        title = document.createElement("div");
        title.className = "devmode-parameter-title";
        signature.before(title);
      }
      const name = signatureFunctionName(code.textContent ?? "");
      if (title.textContent !== `ƒ  ${name}`) {
        title.textContent = `ƒ  ${name}`;
        const contribution = this.codeEditor.getContribution("editor.controller.parameterHints") as {
          widget?: { rawValue?: editor.IContentWidget & { domNodes?: { scrollbar?: { scanDomNode(): void } } } };
        } | null;
        const widget = contribution?.widget?.rawValue;
        widget?.domNodes?.scrollbar?.scanDomNode();
        if (widget) this.codeEditor.layoutContentWidget(widget);
      }
      hints.querySelector(".controls .button:first-child")?.setAttribute("aria-label", "Previous overload");
      hints.querySelector(".controls .button:last-child")?.setAttribute("aria-label", "Next overload");
    }
    if (hoverChanged) this.relayoutHover();
  }

  private readonly onToggle = (event: Event): void => {
    if (!(event.target instanceof Element) || !event.target.closest(".devmode-symbol-hover details")) return;
    this.relayoutHover();
  };

  private relayoutHover(): void {
    // Monaco 0.56 does not observe native <details> size changes. Keep this
    // compatibility bridge isolated and optional when upgrading the editor.
    const contribution = this.codeEditor.getContribution("editor.contrib.contentHover") as {
      _contentWidget?: { widget?: { handleContentsChanged?: () => void } };
    } | null;
    contribution?._contentWidget?.widget?.handleContentsChanged?.();
  }

  private readonly onCopyKey = (event: KeyboardEvent): void => {
    if (event.key === "Enter" || event.key === " ") this.onCopy(event);
  };

  private readonly onCopy = (event: MouseEvent | KeyboardEvent): void => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLElement>(".devmode-symbol-hover .hover-copy-button");
    const hover = button?.closest(".devmode-symbol-hover");
    const code = hover?.querySelector<HTMLElement>(".monaco-tokenized-source, pre code");
    const text = code?.innerText || code?.textContent;
    if (!button || !text || !navigator.clipboard?.writeText) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void navigator.clipboard.writeText(text).then(() => {
      button.setAttribute("aria-label", "Signature copied");
    }).catch(() => {
      button.setAttribute("aria-label", "Unable to copy signature");
    });
  };
}
