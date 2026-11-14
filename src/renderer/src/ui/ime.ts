/** True while an IME composition session is active (candidate selection, etc.). */
export function isImeComposing(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229;
}
