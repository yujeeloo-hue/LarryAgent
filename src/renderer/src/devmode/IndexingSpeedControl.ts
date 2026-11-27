import { createLucideIcon, Zap } from "../ui/originalIcons.js";
import { compactControlIcon } from "./compactControl.js";
import { claimDevModal } from "./modalLayer.js";

type IndexingSpeed = "normal" | "full";

export class IndexingSpeedControl {
  readonly button = document.createElement("button");
  private popup: HTMLElement | null = null;
  private releaseModal: (() => void) | null = null;
  private root: string | null = null;
  private speed: IndexingSpeed = "normal";
  private indexing = false;
  private busy = false;
  private generation = 0;

  constructor(private readonly options: {
    onChanged: (root: string, speed: IndexingSpeed) => void;
    onError: (message: string) => void;
  }) {
    this.button.type = "button";
    this.button.className = "devmode-index-boost";
    this.button.hidden = true;
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.setAttribute("aria-expanded", "false");
    this.button.append(compactControlIcon(Zap));
    this.button.addEventListener("click", () => this.popup ? this.close() : this.open());
  }

  update(root: string | null, indexing: boolean, speed: IndexingSpeed): void {
    if (root !== this.root) {
      this.generation++;
      this.busy = false;
      this.close(false);
    } else if (speed !== this.speed || !indexing) {
      this.close(false);
    }
    this.root = root;
    this.indexing = indexing;
    this.speed = speed;
    this.render();
  }

  destroy(): void {
    this.generation++;
    this.close(false);
    this.button.remove();
  }

  private render(): void {
    const full = this.speed === "full";
    this.button.hidden = !this.root || (!this.indexing && !this.busy) || !window.jellybot?.clangdSetIndexingSpeed;
    this.button.disabled = this.busy;
    this.button.setAttribute("aria-busy", String(this.busy));
    this.button.setAttribute("aria-pressed", String(full));
    this.button.title = full ? "Full speed enabled" : "Full-speed indexing";
    this.button.setAttribute("aria-label", full ? "Manage full-speed indexing" : "Enable full-speed indexing");
  }

  private open(): void {
    if (this.button.hidden || this.busy) return;
    const popup = document.createElement("div");
    popup.className = "devmode-index-boost-popover";
    popup.setAttribute("role", "dialog");
    popup.setAttribute("aria-label", this.speed === "full" ? "Return to normal speed?" : "Full-speed indexing?");
    const question = document.createElement("div");
    question.className = "devmode-index-boost-question";
    question.append(createLucideIcon(Zap), document.createTextNode(popup.getAttribute("aria-label")!));
    const description = document.createElement("p");
    description.className = "devmode-index-boost-description";
    description.textContent = "Uses maximum available resources to finish indexing sooner. Your system may slow down and memory usage may increase.";
    description.hidden = this.speed === "full";
    const actions = document.createElement("div");
    actions.className = "devmode-index-boost-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "devmode-index-boost-action";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => this.close());
    const enable = document.createElement("button");
    enable.type = "button";
    enable.className = "devmode-index-boost-action action-primary";
    enable.textContent = this.speed === "full" ? "Confirm" : "Enable";
    enable.addEventListener("click", () => void this.changeSpeed());
    actions.append(cancel, enable);
    popup.append(question, description, actions);
    this.popup = popup;
    document.body.append(popup);
    this.releaseModal = claimDevModal();
    this.button.setAttribute("aria-expanded", "true");
    this.position();
    window.addEventListener("pointerdown", this.onOutside, true);
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("resize", this.position);
    window.addEventListener("scroll", this.position, true);
    window.addEventListener("blur", this.onBlur);
    cancel.focus();
  }

  private close(restoreFocus = true): void {
    const wasOpen = this.popup !== null;
    this.popup?.remove();
    this.popup = null;
    this.releaseModal?.();
    this.releaseModal = null;
    this.button.setAttribute("aria-expanded", "false");
    window.removeEventListener("pointerdown", this.onOutside, true);
    window.removeEventListener("keydown", this.onKey, true);
    window.removeEventListener("resize", this.position);
    window.removeEventListener("scroll", this.position, true);
    window.removeEventListener("blur", this.onBlur);
    if (wasOpen && restoreFocus && !this.button.hidden) this.button.focus();
  }

  private readonly position = (): void => {
    if (!this.popup) return;
    const anchor = this.button.getBoundingClientRect();
    const rect = this.popup.getBoundingClientRect();
    const above = anchor.top - rect.height - 8;
    this.popup.style.left = `${Math.max(8, Math.min(anchor.right - rect.width, window.innerWidth - rect.width - 8))}px`;
    this.popup.style.top = `${Math.max(8, Math.min(above >= 8 ? above : anchor.bottom + 8, window.innerHeight - rect.height - 8))}px`;
  };

  private readonly onOutside = (event: PointerEvent): void => {
    if (!this.popup?.contains(event.target as Node) && !this.button.contains(event.target as Node)) this.close(false);
  };

  private readonly onBlur = (): void => this.close(false);

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.close();
    } else if (event.key === "Tab" && this.popup) {
      const buttons = [...this.popup.querySelectorAll("button")];
      const target = event.shiftKey ? buttons[0] : buttons[buttons.length - 1];
      if (document.activeElement === target) {
        event.preventDefault();
        (event.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus();
      }
    }
  };

  private async changeSpeed(): Promise<void> {
    const root = this.root;
    const api = window.jellybot?.clangdSetIndexingSpeed;
    if (!root || !api || this.busy) return;
    const generation = this.generation;
    const speed = this.speed === "full" ? "normal" : "full";
    this.close();
    this.busy = true;
    this.render();
    try {
      const result = await api(root, speed);
      if (generation !== this.generation) return;
      if (!result.ok) this.options.onError(result.message);
      else this.options.onChanged(root, result.speed);
    } catch (error) {
      if (generation === this.generation) this.options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === this.generation) {
        this.busy = false;
        this.render();
      }
    }
  }
}
