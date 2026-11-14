/** Presentation for the blame tooltip anchored to Monaco's line-number gutter. */
export class BlameHoverView {
  readonly root: HTMLElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "devmode-blame-hover";
    this.root.setAttribute("role", "tooltip");
    this.root.hidden = true;
    document.body.append(this.root);
  }

  show(text: string, x: number, y: number): void {
    this.root.textContent = text;
    this.root.hidden = false;
    this.root.style.left = `${x + 12}px`;
    this.root.style.top = `${y + 12}px`;

    const rect = this.root.getBoundingClientRect();
    const left = Math.max(8, Math.min(x + 12, window.innerWidth - rect.width - 8));
    const top = Math.max(8, Math.min(y + 12, window.innerHeight - rect.height - 8));
    this.root.style.left = `${left}px`;
    this.root.style.top = `${top}px`;
  }

  hide(): void {
    this.root.hidden = true;
  }

  destroy(): void {
    this.root.remove();
  }
}
