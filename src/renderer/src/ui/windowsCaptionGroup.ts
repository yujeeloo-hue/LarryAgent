import { Copy, Minus, Square, X, createLucideIcon } from "./icons.js";

/**
 * Windows self-drawn caption buttons (min / max / close) for windows that
 * hide the native title bar. Returns null off-Windows or without the bridge
 * so callers can mount unconditionally. Styles live in
 * styles/windowChrome.css (class names shared with the main title bar);
 * the host chrome must let the group stretch to its full height.
 */
export function createWindowsCaptionGroup(): HTMLElement | null {
  const bridge = window.jellybot;
  if (bridge?.platform !== "win32" || !bridge.windowControls) return null;
  const controls = bridge.windowControls;

  const mkButton = (className: string, label: string): HTMLButtonElement => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = className;
    btn.setAttribute("aria-label", label);
    btn.title = label;
    return btn;
  };

  const minimizeButton = mkButton("title-bar-caption-btn", "Minimize");
  minimizeButton.append(
    createLucideIcon(Minus, { size: 12, strokeWidth: 1.5 }),
  );
  minimizeButton.addEventListener("click", () => void controls.minimize());

  const maximizeButton = mkButton("title-bar-caption-btn", "Maximize");
  const glyphMax = createLucideIcon(Square, { size: 11, strokeWidth: 1.5 });
  const glyphRestore = createLucideIcon(Copy, { size: 11, strokeWidth: 1.5 });
  maximizeButton.append(glyphMax);
  maximizeButton.addEventListener("click", () =>
    void controls.toggleMaximize(),
  );
  bridge.onWindowMaximizeChanged?.(({ maximized }) => {
    const label = maximized ? "Restore" : "Maximize";
    maximizeButton.title = label;
    maximizeButton.setAttribute("aria-label", label);
    maximizeButton.replaceChildren(maximized ? glyphRestore : glyphMax);
  });

  const closeButton = mkButton(
    "title-bar-caption-btn caption-close",
    "Close",
  );
  closeButton.append(createLucideIcon(X, { size: 12, strokeWidth: 1.5 }));
  closeButton.addEventListener("click", () => void controls.close());

  const group = document.createElement("div");
  group.className = "title-bar-caption-group";
  group.append(minimizeButton, maximizeButton, closeButton);
  return group;
}
