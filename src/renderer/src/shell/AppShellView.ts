export class AppShellView {
  readonly root: HTMLElement;
  readonly sidebarSlot: HTMLElement;
  readonly resizeHandle: HTMLElement;
  readonly titleBarSlot: HTMLElement;
  readonly mainSlot: HTMLElement;
  readonly mainColumn: HTMLElement;
  readonly drawerSlot: HTMLElement;
  readonly drawerResizeHandle: HTMLElement;
  readonly drawerContent: HTMLElement;

  private readonly bodyRow: HTMLElement;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "app-shell";

    this.sidebarSlot = document.createElement("div");
    this.sidebarSlot.className = "app-shell-sidebar";

    this.resizeHandle = document.createElement("div");
    this.resizeHandle.className = "app-shell-resize";
    this.resizeHandle.setAttribute("role", "separator");
    this.resizeHandle.setAttribute("aria-orientation", "vertical");
    this.resizeHandle.setAttribute("aria-label", "Resize sidebar");
    this.resizeHandle.title = "Drag to resize";
    this.resizeHandle.tabIndex = 0;

    this.mainColumn = document.createElement("div");
    this.mainColumn.className = "app-shell-main-column";

    this.titleBarSlot = document.createElement("div");
    this.titleBarSlot.className = "app-shell-titlebar";

    this.mainSlot = document.createElement("main");
    this.mainSlot.className = "app-shell-main";
    this.mainSlot.setAttribute("role", "main");

    this.drawerSlot = document.createElement("div");
    this.drawerSlot.className = "app-shell-drawer";
    this.drawerSlot.setAttribute("aria-hidden", "true");

    this.drawerResizeHandle = document.createElement("div");
    this.drawerResizeHandle.className = "app-shell-drawer-resize";
    this.drawerResizeHandle.setAttribute("role", "separator");
    this.drawerResizeHandle.setAttribute("aria-orientation", "horizontal");
    this.drawerResizeHandle.setAttribute("aria-label", "Resize Detail panel");
    this.drawerResizeHandle.title = "Drag to resize";
    this.drawerResizeHandle.tabIndex = 0;
    this.drawerResizeHandle.hidden = true;

    this.drawerContent = document.createElement("div");
    this.drawerContent.className = "app-shell-drawer-body";

    this.drawerSlot.append(this.drawerResizeHandle, this.drawerContent);
    // Normal mode: the title bar covers only the main column; the sidebar
    // reserves the traffic-light corner with its own drag region.
    this.mainColumn.append(this.titleBarSlot, this.mainSlot, this.drawerSlot);
    // Dev Mode moves this wrapper in (setDevModeLayout): title bar on top,
    // full width; sidebar | resize | main column below.
    this.bodyRow = document.createElement("div");
    this.bodyRow.className = "app-shell-body";
    this.bodyRow.append(this.sidebarSlot, this.resizeHandle, this.mainColumn);
    this.root.append(this.sidebarSlot, this.resizeHandle, this.mainColumn);
  }

  /**
   * Dev Mode layout variant (plan: dev-mode-v1) — the shell owns the swap so
   * normal mode keeps its original DOM & styling untouched.
   */
  setDevModeLayout(active: boolean): void {
    if (active) {
      this.mainColumn.append(this.mainSlot, this.drawerSlot);
      this.bodyRow.append(this.sidebarSlot, this.resizeHandle, this.mainColumn);
      this.root.replaceChildren(this.titleBarSlot, this.bodyRow);
    } else {
      this.mainColumn.prepend(this.titleBarSlot);
      this.mainColumn.insertBefore(this.mainSlot, this.drawerSlot);
      this.root.replaceChildren(this.sidebarSlot, this.resizeHandle, this.mainColumn);
    }
  }

  setDrawerOpen(open: boolean): void {
    this.drawerSlot.classList.toggle("is-open", open);
    this.drawerSlot.setAttribute("aria-hidden", open ? "false" : "true");
    this.drawerResizeHandle.hidden = !open;
  }

  setSidebarWidth(px: number): void {
    this.root.style.setProperty("--sidebar-width", `${Math.round(px)}px`);
    this.resizeHandle.setAttribute("aria-valuenow", String(Math.round(px)));
  }

  /** Dev Mode layout variant (three-column workbench, plan: dev-mode-v1). */
  setDevModeActive(active: boolean): void {
    this.root.classList.toggle("is-dev-mode", active);
  }

  setResizeDragging(dragging: boolean): void {
    this.resizeHandle.classList.toggle("is-dragging", dragging);
    this.root.classList.toggle("is-sidebar-resizing", dragging);
  }

  /** Height as a fraction of the main column (0–1), applied as percent. */
  setDrawerHeightRatio(ratio: number): void {
    const pct = Math.round(ratio * 1000) / 10;
    this.root.style.setProperty("--detail-drawer-height", `${pct}%`);
    this.drawerResizeHandle.setAttribute(
      "aria-valuenow",
      String(Math.round(pct)),
    );
  }

  setDrawerResizeDragging(dragging: boolean): void {
    this.drawerResizeHandle.classList.toggle("is-dragging", dragging);
    this.root.classList.toggle("is-drawer-resizing", dragging);
  }
}
