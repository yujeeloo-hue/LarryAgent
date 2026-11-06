import { createAppBrandIcon } from "../ui/appBrandIcon.js";

export class SidebarView {
  readonly root: HTMLElement;
  readonly agentSlot: HTMLElement;
  readonly sessionsSlot: HTMLElement;
  readonly archivedSlot: HTMLElement;


  constructor() {
    this.root = document.createElement("aside");
    this.root.className = "sidebar";
    this.root.setAttribute("aria-label", "Sidebar");

    // Normal mode: the sidebar's top 40px is a drag region that reserves the
    // macOS traffic-light corner (and hosts the Windows app name). Dev Mode
    // replaces the whole sidebar slot with the Solution Outline, which sits
    // safely below the full-width title bar instead.
    const dragRegion = document.createElement("div");
    dragRegion.className = "sidebar-drag-region";
    dragRegion.setAttribute("aria-hidden", "true");

    // Windows top-left brand: 16px icon + name (approved option A,
    // scripts/titlebar-brand-icon-demo.html); hidden on macOS.
    const brand = document.createElement("div");
    brand.className = "sidebar-brand";
    const brandIcon = createAppBrandIcon();
    const appName = document.createElement("span");
    appName.className = "sidebar-app-name";
    appName.textContent = window.jellybot?.appName || "Larry Agent";
    brand.append(brandIcon, appName);
    dragRegion.append(brand);

    const content = document.createElement("div");
    content.className = "sidebar-content";

    this.agentSlot = document.createElement("div");
    this.agentSlot.className = "sidebar-agent";

    const lower = document.createElement("div");
    lower.className = "sidebar-lower";

    this.sessionsSlot = document.createElement("div");
    this.sessionsSlot.className = "sidebar-sessions";

    this.archivedSlot = document.createElement("div");
    this.archivedSlot.className = "sidebar-sessions";
    this.archivedSlot.hidden = true;

    lower.append(this.sessionsSlot, this.archivedSlot);
    content.append(this.agentSlot, lower);
    this.root.append(dragRegion, content);
  }
}
