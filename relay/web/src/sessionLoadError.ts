/**
 * Session-load failure view: the centered "Failed to load session." note plus
 * a Retry button that refetches the snapshot in place (no hard reload) and a
 * Back-to-home escape hatch — a failed fetch leaves no conversation chrome
 * (no header, no mobile back button), so without it the view is a dead end.
 * Extracted from main.ts so the affordance is testable without booting the
 * whole console app.
 */
export function sessionLoadErrorView(onRetry: () => void, onHome: () => void): HTMLElement {
  const note = document.createElement("div");
  note.className = "empty-note conv-load-error";
  const text = document.createElement("span");
  text.textContent = "Failed to load session.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn ghost";
  retry.textContent = "Retry";
  retry.addEventListener("click", onRetry);
  const home = document.createElement("button");
  home.type = "button";
  home.className = "btn ghost";
  home.textContent = "Back to home";
  home.addEventListener("click", onHome);
  note.append(text, retry, home);
  return note;
}
