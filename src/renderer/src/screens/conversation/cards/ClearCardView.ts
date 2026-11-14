/** Centered "Conversation cleared" divider shown at a /clear marker. */
export function createClearCard(): HTMLElement {
  const row = document.createElement("div");
  row.className = "content-card-compaction-hint";

  const left = document.createElement("span");
  left.className = "content-card-compaction-rule";
  left.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.className = "content-card-compaction-label";
  label.textContent = "Conversation cleared";

  const right = document.createElement("span");
  right.className = "content-card-compaction-rule";
  right.setAttribute("aria-hidden", "true");

  row.append(left, label, right);
  return row;
}
