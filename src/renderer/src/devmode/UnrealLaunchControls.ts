import type { UnrealBuildChoice, UnrealWorkspace } from "../../../unreal/workspaceTypes.js";
import { createDevModeIcon, type DevModeIconName } from "./launchIcon.js";
import { AppDropdown } from "../ui/appDropdown.js";

/** Unreal provider UI. Detached for ordinary workspaces, preserving their toolbar. */
export class UnrealLaunchControls {
  private root: string | null = null;
  private generation = 0;
  private model: UnrealWorkspace | null = null;
  private popup: HTMLElement | null = null;
  /** Field dropdowns of the open menu — their listboxes portal to <body>. */
  private dropdowns: AppDropdown[] = [];
  private arrow = document.createElement("button");
  private run = document.createElement("button");
  private runId: string | null = null;
  private runPending = false;
  private stopPending = false;
  private debugLive = false;
  private debugRoot = "";
  private selecting = false;
  private building = false;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private offs: Array<() => void> = [];

  constructor(private build: HTMLButtonElement, private debug: HTMLButtonElement, private callbacks: {
    revealTask: (task: string) => void;
    debug: (id: string) => void;
    stopDebug: () => void;
  }) {
    this.arrow.type = "button";
    this.arrow.className = "devmode-launch-btn devmode-build-selector";
    this.arrow.setAttribute("aria-label", "Select build configuration, platform and target");
    this.arrow.setAttribute("aria-haspopup", "dialog");
    this.arrow.setAttribute("aria-expanded", "false");
    const triangle = document.createElement("span");
    triangle.className = "devmode-build-triangle";
    this.arrow.append(triangle);
    this.arrow.addEventListener("click", () => this.popup ? this.closeMenu() : this.openMenu());
    this.run.type = "button";
    this.run.className = "devmode-launch-btn";
    this.run.append(createDevModeIcon("run"));
    this.run.addEventListener("click", () => void this.runOrStop());
    this.offs.push(window.jellybot?.onDevTaskExit?.(event => {
      if (!this.sameRoot(event.workspacePath)) return;
      if (event.task === "build") { this.building = false; this.paint(); }
      if (event.task === "run" && event.runId === this.runId) { this.runId = null; this.runPending = false; this.stopPending = false; this.paint(); }
    }) ?? (() => {}));
  }

  get active(): boolean { return this.model !== null; }
  get sourceRoots(): string[] { return this.model ? [this.model.workspacePath, ...(this.model.engineRoot ? [this.model.engineRoot] : []), ...this.model.projects.map(p => p.sourceRoot)] : []; }
  private sameRoot(path: string): boolean { return path.replace(/\\/g, "/").toLowerCase() === this.root?.replace(/\\/g, "/").toLowerCase(); }
  private choice(): UnrealBuildChoice | undefined { return this.model?.choices.find(c => c.id === this.model?.selectedId); }
  private icon(button: HTMLButtonElement, name: DevModeIconName, label: string): void {
    const old = button.querySelector("img");
    if (old?.dataset.devModeIcon !== name) {
      const icon = createDevModeIcon(name);
      if (old) old.replaceWith(icon); else button.prepend(icon);
    }
    button.title = label;
    button.setAttribute("aria-label", label);
  }
  private paint(): void {
    if (!this.model) { this.arrow.remove(); this.run.remove(); this.icon(this.debug, "run", this.debug.title); this.build.disabled = false; return; }
    if (this.model.hasChoices) this.build.before(this.arrow); else this.arrow.remove();
    this.debug.before(this.run);
    const choice = this.choice();
    const summary = choice ? `${choice.target} · ${choice.configuration} · ${choice.platform}${choice.architecture ? ` · ${choice.architecture}` : ""}` : this.model.warnings.join("\n");
    this.arrow.title = summary;
    const debugLive = this.debugLive && this.sameRoot(this.debugRoot);
    const running = !!this.runId || this.runPending;
    this.arrow.disabled = this.selecting || running || debugLive || this.building;
    this.build.disabled = this.selecting || !choice || !!choice.buildReason || running || debugLive || this.building;
    this.build.title = choice?.buildReason ?? `Build — ${summary}`;
    const note = choice?.runNote ? `\n${choice.runNote}` : "";
    this.icon(this.run, running ? "stop" : "run", running ? "Stop running" : choice?.runReason ?? `Run — ${summary}${note}`);
    this.run.disabled = this.stopPending || (!running && (this.selecting || !choice || !!choice.runReason || this.debugLive || this.building));
    this.icon(this.debug, debugLive ? "stop" : "debug", debugLive ? "Stop debugging" : choice?.debugReason ?? `Debug — ${summary}${note}`);
    this.debug.disabled = !debugLive && (this.selecting || !choice || !!choice.debugReason || running || this.building || this.debugLive);
  }
  async setWorkspace(root: string | null, refresh = false): Promise<void> {
    const generation = ++this.generation;
    this.closeMenu();
    this.root = root;
    this.model = null; this.runId = null; this.runPending = false; this.stopPending = false; this.building = false; this.selecting = false;
    this.paint();
    if (!root || !window.jellybot?.getUnrealWorkspace) return;
    let result, state;
    try { [result, state] = await Promise.all([window.jellybot.getUnrealWorkspace(root, refresh), window.jellybot.getDevTaskState(root)]); }
    catch { return; }
    if (generation !== this.generation) return;
    if (result.ok) this.model = result.workspace;
    this.runId = state.active.find(r => r.task === "run")?.runId ?? null;
    this.building = state.active.some(r => r.task === "build");
    this.paint();
  }
  refreshForFiles(events: Array<{ path: string }>): void {
    if (!events.some(e => /(?:\.sln|\.uproject|\.Target\.cs|\.Build\.cs|\.vcxproj|\.csproj|\/\.Rider\/.*\.json)$/i.test(e.path.replace(/\\/g, "/")))) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { if (this.root && !this.runId && !this.debugLive && !this.building) void this.setWorkspace(this.root, true); }, 800);
  }
  setDebugState(snapshot: { status: string; workspacePath: string }): void {
    this.debugLive = ["building", "starting", "running", "stopped"].includes(snapshot.status);
    this.debugRoot = snapshot.workspacePath;
    if (this.active) this.paint();
  }
  setBuildState(running: boolean): void { this.building = running; if (this.active) this.paint(); }
  debugClick(): void {
    if (this.debugLive && this.sameRoot(this.debugRoot)) this.callbacks.stopDebug();
    else { const choice = this.choice(); if (choice && !choice.debugReason) this.callbacks.debug(choice.id); }
  }
  async buildSelected(operation: "build" | "rebuild" | "clean" = "build"): Promise<void> {
    const choice = this.choice(), root = this.root;
    if (!choice || !root || this.build.disabled) return;
    this.closeMenu();
    this.callbacks.revealTask("build");
    this.building = true; this.paint();
    try {
      const result = await window.jellybot!.buildUnreal(root, choice.id, operation);
      if (!result.ok) { if (this.root === root) { this.building = false; this.paint(); } window.alert(result.message); }
      else {
        const state = await window.jellybot!.getDevTaskState(root);
        if (this.root === root && !state.active.some(r => r.runId === result.runId)) { this.building = false; this.paint(); }
      }
    } catch (error) { if (this.root === root) { this.building = false; this.paint(); } window.alert(String(error)); }
  }
  private async runOrStop(): Promise<void> {
    const bridge = window.jellybot;
    if (!bridge) return;
    if (this.runId || this.runPending) {
      this.stopPending = true; this.paint();
      if (this.runId) await bridge.stopDevTask(this.runId);
      return;
    }
    const choice = this.choice(), root = this.root, generation = this.generation;
    if (!root || !choice || choice.runReason) return;
    this.runPending = true; this.paint(); this.callbacks.revealTask("run");
    try {
      const result = await bridge.runUnreal(root, choice.id);
      if (generation !== this.generation) return;
      this.runPending = false;
      if (result.ok) {
        this.runId = result.runId;
        if (this.stopPending) await bridge.stopDevTask(result.runId);
        // A very short process can exit before IPC resolves.
        const state = await bridge.getDevTaskState(root);
        if (generation === this.generation && !state.active.some(r => r.runId === result.runId)) { this.runId = null; this.stopPending = false; }
      } else { this.stopPending = false; window.alert(result.message); }
    } catch (error) { if (generation === this.generation) { this.runPending = false; this.stopPending = false; window.alert(String(error)); } }
    if (generation === this.generation) this.paint();
  }

  private openMenu(): void {
    const choice = this.choice(), model = this.model;
    if (!choice || !model || this.arrow.disabled) return;
    this.closeMenu();
    const popup = document.createElement("div");
    popup.className = "devmode-build-menu";
    popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", "Build configuration");
    const fields: Array<[keyof UnrealBuildChoice, string]> = [["solution", "Solution"], ["target", "Target"], ["configuration", "Configuration"], ["platform", "Platform"], ["architecture", "Architecture"]];
    this.dropdowns = [];
    for (const [field, title] of fields) {
      const pool = model.choices.filter(c => field === "solution" || (c.solution === choice.solution && (field === "target" || c.target === choice.target)));
      const values = [...new Set(pool.map(c => String(c[field] ?? "")))];
      if ((field === "solution" || field === "architecture") && values.length < 2) continue;
      const label = document.createElement("label"); label.textContent = title;
      const dropdown = new AppDropdown(
        values.map(value => ({
          value,
          label: field === "solution" ? value.replace(/\\/g, "/").split("/").at(-1)! : value || "Default",
        })),
        String(choice[field] ?? ""),
        { className: "devmode-build-field", ariaLabel: title },
      );
      dropdown.addEventListener("change", () => {
        const candidates = pool.filter(c => c[field] === dropdown.value);
        const score = (c: UnrealBuildChoice) => fields.filter(([key]) => key !== field && c[key] === choice[key]).length;
        const next = candidates.sort((a, b) => score(b) - score(a))[0];
        if (next) void this.select(next.id);
      });
      label.append(dropdown.el); popup.append(label);
      this.dropdowns.push(dropdown);
    }
    this.popup = popup; document.body.append(popup);
    const rect = this.arrow.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    popup.style.left = `${Math.max(8, Math.min(rect.left, viewportWidth - 300))}px`;
    popup.style.top = `${rect.bottom + 6}px`;
    popup.style.maxHeight = `${Math.max(100, window.innerHeight - rect.bottom - 14)}px`;
    this.arrow.setAttribute("aria-expanded", "true");
    document.addEventListener("pointerdown", this.outside, true);
    document.addEventListener("keydown", this.escape, true);
    window.addEventListener("resize", this.closeOnResize);
    popup.querySelector<HTMLButtonElement>(".app-dropdown-btn")?.focus();
  }
  private async select(id: string): Promise<void> {
    const root = this.root, generation = this.generation;
    if (!root) return;
    this.selecting = true; this.paint(); this.closeMenu();
    try {
      const result = await window.jellybot!.selectUnrealBuild(root, id);
      if (generation !== this.generation) return;
      if (result.ok) this.model = result.workspace; else window.alert(result.message);
    } catch (error) { if (generation === this.generation) window.alert(String(error)); }
    finally { if (generation === this.generation) { this.selecting = false; this.paint(); this.openMenu(); } }
  }
  private outside = (event: Event) => {
    if (this.popup?.contains(event.target as Node) || this.arrow.contains(event.target as Node)) return;
    // Field listboxes portal to <body>, so they sit outside this popup's DOM;
    // clicking one — or dragging its scrollbar — must keep the menu open.
    if (this.dropdowns.some(dropdown => dropdown.ownsEvent(event))) return;
    this.closeMenu();
  };
  private escape = (event: KeyboardEvent) => { if (!event.defaultPrevented && event.key === "Escape") { event.preventDefault(); this.closeMenu(); this.arrow.focus(); } };
  private closeOnResize = () => this.closeMenu();
  private closeMenu(): void {
    this.popup?.remove(); this.popup = null; this.dropdowns = []; this.arrow.setAttribute("aria-expanded", "false");
    document.removeEventListener("pointerdown", this.outside, true); document.removeEventListener("keydown", this.escape, true); window.removeEventListener("resize", this.closeOnResize);
  }
  dispose(): void { this.generation++; this.closeMenu(); if (this.refreshTimer) clearTimeout(this.refreshTimer); this.offs.forEach(off => off()); }
}
