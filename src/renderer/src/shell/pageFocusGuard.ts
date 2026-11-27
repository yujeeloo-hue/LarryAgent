const EDITABLE_SELECTOR =
  'input, textarea, [contenteditable=""], [contenteditable="true"]';

function editableFrom(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest(EDITABLE_SELECTOR);
  if (!(element instanceof HTMLElement)) return null;
  if ((element as HTMLInputElement).disabled) return null;
  return element;
}

function reassertPageFocus(editable: HTMLElement | null): void {
  const request = window.jellybot?.reassertWindowFocus?.();
  if (!request) {
    editable?.focus({ preventScroll: true });
    return;
  }
  void request.then(() => {
    if (!editable?.isConnected) return;
    editable.focus({ preventScroll: true });
  });
}

/**
 * Fallback for window-level focus desync.
 *
 * On Windows, after an external process dialog (Unreal/UBT error boxes, etc.) closes, the main window can be left
 * in a state where the OS considers it active but webContents still reports unfocused: clicks dispatch normally
 * (buttons react, the cursor becomes an I-beam), but Chromium does not give focus to text fields — Composer and
 * terminal inputs stop accepting clicks until Alt+Tab or opening DevTools triggers a real activation cycle.
 *
 * On pointer down: if the page reports unfocused, ask the main process to restore focus and also focus the
 * clicked input (otherwise the click is wasted and the user has to click again).
 */
export function installPageFocusGuard(): void {
  document.addEventListener(
    "pointerdown",
    (event) => {
      const editable = editableFrom(event.target);
      if (!document.hasFocus()) {
        reassertPageFocus(editable);
        return;
      }
      if (!editable) return;
      // The page claims focus but the click did not focus this input: recheck on the next frame.
      // Skip when someone explicitly called preventDefault on the press (a component intentionally keeps focus off the input).
      requestAnimationFrame(() => {
        if (event.defaultPrevented) return;
        if (!editable.isConnected || document.activeElement === editable) return;
        editable.focus({ preventScroll: true });
      });
    },
    true,
  );
}
