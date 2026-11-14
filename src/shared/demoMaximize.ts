/** Window-sized demo previews shared by the desktop client and Relay. */
import { DEMO_ESCAPE_MESSAGE_TYPE } from "./demoEscapeBridge.js";

// Lucide maximize/minimize (ISC), matching the existing parameter control.
const MAXIMIZE_ICON = '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/>';
const RESTORE_ICON = '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>';

/**
 * The preview itself is a persistent dialog, styled inline while closed.
 * showModal promotes the same element to the top layer: neither the iframe
 * nor its browsing context moves, so scripts, scroll and input state survive.
 */
export function appendDemoMaximize(
  preview: HTMLDialogElement,
  title: string,
): { restore(): void } {
  preview.setAttribute("role", "region");
  preview.setAttribute("aria-label", `${title} preview`);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "content-card-demo-maximize";
  button.setAttribute("aria-haspopup", "dialog");
  let observer: MutationObserver | null = null;
  const onMessage = (event: MessageEvent): void => {
    if (event.data?.type !== DEMO_ESCAPE_MESSAGE_TYPE || !preview.open) return;
    const frame = preview.querySelector("iframe");
    if (!frame?.contentWindow || event.source !== frame.contentWindow) return;
    if (!dismissParams()) restore();
  };
  const stopListening = (): void => {
    window.removeEventListener("message", onMessage);
    observer?.disconnect();
    observer = null;
  };
  const sync = (): void => {
    const maximized = preview.open;
    button.setAttribute("aria-label", maximized ? "Restore demo" : "Maximize demo");
    button.setAttribute("aria-expanded", String(maximized));
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${maximized ? RESTORE_ICON : MAXIMIZE_ICON}</svg>`;
    preview.setAttribute("role", maximized ? "dialog" : "region");
    if (maximized) preview.setAttribute("aria-modal", "true");
    else {
      preview.removeAttribute("aria-modal");
      stopListening();
    }
  };
  const dismissParams = (): boolean => {
    const toggle = preview.querySelector('[aria-expanded="true"].content-card-demo-params-toggle');
    const popup = preview.querySelector<HTMLElement>(".content-card-demo-params-popover");
    if (!toggle || !popup) return false;
    popup.hidePopover();
    return true;
  };
  const restore = (): void => {
    if (!preview.open) return;
    dismissParams();
    preview.close();
    sync();
    if (button.isConnected) button.focus({ preventScroll: true });
  };
  button.addEventListener("click", () => {
    if (preview.open) { restore(); return; }
    dismissParams();
    preview.showModal();
    sync();
    window.addEventListener("message", onMessage);
    observer = new window.MutationObserver(() => {
      if (!preview.isConnected) { restore(); stopListening(); }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    button.focus({ preventScroll: true });
  });
  preview.addEventListener("cancel", (event) => {
    // Parameter UI dismisses before the maximized preview (including Esc).
    if (dismissParams()) event.preventDefault();
  });
  preview.addEventListener("close", () => {
    // A queued close event must not reset a subsequently reopened dialog.
    if (preview.open) return;
    sync();
    if (button.isConnected) button.focus({ preventScroll: true });
  });
  sync();
  preview.append(button);
  return { restore };
}
