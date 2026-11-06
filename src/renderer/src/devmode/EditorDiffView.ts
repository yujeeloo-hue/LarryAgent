/**
 * Dev Mode side-by-side diff presentation.
 *
 * Monaco owns the inner editor host; this view only owns layout, labels and
 * loading/error feedback. VCS reads and editor lifecycle stay in the controller.
 */
export class EditorDiffView {
  readonly root: HTMLElement;
  readonly editorHost: HTMLElement;
  private readonly notice: HTMLElement;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "devmode-diff";
    this.root.hidden = true;

    const headings = document.createElement("div");
    headings.className = "devmode-diff-headings";
    const base = document.createElement("span");
    base.textContent = "Working Base";
    const local = document.createElement("span");
    local.textContent = "Local Changes";
    headings.append(base, local);

    this.editorHost = document.createElement("div");
    this.editorHost.className = "devmode-diff-editor";

    this.notice = document.createElement("div");
    this.notice.className = "devmode-diff-notice";
    this.notice.hidden = true;

    this.root.append(headings, this.editorHost, this.notice);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  setLoading(loading: boolean): void {
    this.root.classList.toggle("is-loading", loading);
    this.notice.hidden = !loading;
    this.notice.classList.remove("is-error");
    this.notice.textContent = loading ? "Loading working base…" : "";
  }

  setError(message: string): void {
    this.root.classList.remove("is-loading");
    this.notice.hidden = false;
    this.notice.classList.add("is-error");
    this.notice.textContent = message;
  }

  clearNotice(): void {
    this.root.classList.remove("is-loading");
    this.notice.hidden = true;
    this.notice.classList.remove("is-error");
    this.notice.textContent = "";
  }
}
