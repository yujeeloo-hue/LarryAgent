/**
 * New-workspace flow: template menu → pick folder → create dialog → init
 * progress. Shared by both entry points (sidebar `+`, New Task workspace
 * menu). Blank keeps the legacy register-only path.
 *
 * UI mirrors the approved demo (/tmp/jb-ws-template-demo): detection rows
 * instead of checkboxes ("will run" / "skip — exists" / "n/a — Unreal"),
 * checklist steps with skipped marks, install streams its last output line.
 */
import "./new-workspace-flow.css";
import unrealMarkSvg from "../assets/brand-icons/unreal.svg?raw";
import { isImeComposing } from "./ime.js";
import { createLucideIcon as createOriginalIcon } from "./originalIcons.js";
import { showTextPromptDialog } from "./TextPromptDialogView.js";
import {
  Atom,
  Check,
  FileText,
  Folder,
  Globe,
  Minus,
  createLucideIcon,
} from "./icons.js";

export type NewWorkspaceHooks = {
  /** Fired once the workspace is registered (sidebar/task view refresh). */
  onCreated?: (workspace: Workspace) => void;
};

type Bridge = NonNullable<typeof window.jellybot>;

function requireBridge(): Bridge | null {
  const bridge = window.jellybot;
  if (!bridge?.pickWorkspaceFolder) return null;
  return bridge;
}

function folderBasename(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? "Workspace";
}

/* ------------------------------------------------------ icons */

function templateIcon(iconId: WorkspaceTemplateIconId): HTMLElement | SVGElement {
  if (iconId === "unreal") {
    const box = document.createElement("span");
    box.className = "nws-unreal-mark";
    box.innerHTML = unrealMarkSvg;
    const svg = box.firstElementChild;
    svg?.removeAttribute("width");
    svg?.removeAttribute("height");
    return box;
  }
  const lucide =
    iconId === "globe" ? Globe : iconId === "atom" ? Atom : FileText;
  return createLucideIcon(lucide, { size: 15 });
}

/* ------------------------------------------------------ template menu */

/**
 * Open the template dropdown anchored below `anchor`. Falls back to the
 * blank flow when the template registry is unreachable.
 */
export function openWorkspaceTemplateMenu(
  anchor: HTMLElement,
  hooks: NewWorkspaceHooks,
): void {
  void (async () => {
    const bridge = requireBridge();
    if (!bridge) {
      await runBlankFlow(hooks);
      return;
    }
    let templates: WorkspaceTemplateInfo[] = [];
    if (bridge.listWorkspaceTemplates) {
      try {
        templates = await bridge.listWorkspaceTemplates();
      } catch (err) {
        console.error("[new-workspace] template list failed", err);
      }
    }
    if (templates.length === 0) {
      await runBlankFlow(hooks);
      return;
    }
    openMenuDropdown(anchor, templates, bridge, hooks);
  })();
}

function openMenuDropdown(
  anchor: HTMLElement,
  templates: readonly WorkspaceTemplateInfo[],
  bridge: Bridge,
  hooks: NewWorkspaceHooks,
): void {
  closeMenuDropdown();

  const menu = document.createElement("div");
  menu.className = "nws-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "New workspace");

  const label = document.createElement("div");
  label.className = "nws-menu-label";
  label.textContent = "New workspace";
  menu.append(label);

  const selectable: HTMLButtonElement[] = [];
  const addItem = (info: WorkspaceTemplateInfo, isBlank: boolean): void => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "nws-menu-item" + (isBlank ? " nws-menu-item-blank" : "");
    item.setAttribute("role", "menuitem");

    const ico = document.createElement("span");
    ico.className = "nws-ico";
    ico.append(templateIcon(info.iconId));

    const txt = document.createElement("span");
    txt.className = "nws-menu-txt";
    const name = document.createElement("span");
    name.className = "nws-menu-name";
    name.textContent = info.name;
    const desc = document.createElement("span");
    desc.className = "nws-menu-desc";
    desc.textContent = info.desc;
    txt.append(name, desc);

    item.append(ico, txt);
    item.addEventListener("click", () => {
      closeMenuDropdown();
      if (isBlank) void runBlankFlow(hooks);
      else void runTemplateFlow(info, bridge, hooks);
    });
    menu.append(item);
    selectable.push(item);
  };

  for (const t of templates) {
    if (t.id !== "blank") addItem(t, false);
  }
  const blank = templates.find((t) => t.id === "blank");
  if (blank) {
    const sep = document.createElement("div");
    sep.className = "nws-menu-sep";
    menu.append(sep);
    addItem(blank, true);
  }

  document.body.append(menu);
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - menu.offsetHeight - 8)}px`;

  let kbdIndex = -1;
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenuDropdown();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (selectable.length === 0) return;
      kbdIndex =
        event.key === "ArrowDown"
          ? (kbdIndex + 1) % selectable.length
          : (kbdIndex - 1 + selectable.length) % selectable.length;
      selectable.forEach((el, i) => el.classList.toggle("is-kbd-focus", i === kbdIndex));
      selectable[kbdIndex]?.focus();
      return;
    }
    if (event.key === "Enter" && kbdIndex >= 0) {
      event.preventDefault();
      selectable[kbdIndex]?.click();
    }
  };
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && !menu.contains(target) && target !== anchor) {
      closeMenuDropdown();
    }
  };
  const onBlur = (): void => closeMenuDropdown();

  menuDropdownState = { menu, onKey, onPointerDown, onBlur };
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  window.addEventListener("blur", onBlur);
}

let menuDropdownState: {
  menu: HTMLElement;
  onKey: (event: KeyboardEvent) => void;
  onPointerDown: (event: PointerEvent) => void;
  onBlur: () => void;
} | null = null;

function closeMenuDropdown(): void {
  const state = menuDropdownState;
  if (!state) return;
  menuDropdownState = null;
  document.removeEventListener("keydown", state.onKey, true);
  document.removeEventListener("pointerdown", state.onPointerDown, true);
  window.removeEventListener("blur", state.onBlur);
  state.menu.remove();
}

/* ------------------------------------------------------ blank flow (legacy) */

async function runBlankFlow(hooks: NewWorkspaceHooks): Promise<void> {
  const bridge = requireBridge();
  if (!bridge?.createWorkspace) return;
  const path = await bridge.pickWorkspaceFolder();
  if (!path) return;
  const defaultName = folderBasename(path);
  const name = await showTextPromptDialog({
    title: "New workspace",
    message: path,
    defaultValue: defaultName,
    confirmLabel: "Create",
  });
  if (name === null) return;
  try {
    const workspace = await bridge.createWorkspace({
      name: name.trim() || defaultName,
      path,
    });
    hooks.onCreated?.(workspace);
  } catch (err) {
    await reportError(bridge, err);
  }
}

async function reportError(bridge: Bridge, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  if (bridge.alertDialog) {
    await bridge.alertDialog({ message, type: "error", title: "Error" });
  } else {
    window.alert(message);
  }
}

/* ------------------------------------------------------ template flow */

async function runTemplateFlow(
  template: WorkspaceTemplateInfo,
  bridge: Bridge,
  hooks: NewWorkspaceHooks,
): Promise<void> {
  if (!bridge.createWorkspaceFromTemplate || !bridge.inspectWorkspaceInit) {
    await runBlankFlow(hooks);
    return;
  }
  const path = await bridge.pickWorkspaceFolder();
  if (!path) return;

  const submitted = await showCreateDialog(template, path, bridge);
  if (!submitted) return;

  await runInitDialog(template, submitted.name, submitted.path, bridge, hooks);
}

/* ------------------------------------------------------ create dialog */

function inspectionStateText(
  state: WorkspaceInitPlanState | undefined,
  fallback: "will-run" | "n-a",
): string {
  switch (state ?? fallback) {
    case "skip-exists":
      return "skip — already exists";
    case "n-a":
      return "n/a — Unreal";
    default:
      return "will run";
  }
}

function showCreateDialog(
  template: WorkspaceTemplateInfo,
  initialPath: string,
  bridge: Bridge,
): Promise<{ name: string; path: string } | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "nws-overlay";

    const dialog = document.createElement("div");
    dialog.className = "nws-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const title = document.createElement("h2");
    title.className = "nws-dialog-title";
    title.textContent = `New workspace — ${template.name}`;

    const pathRow = document.createElement("p");
    pathRow.className = "nws-path";

    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "nws-input";
    nameInput.spellcheck = false;
    nameInput.autocomplete = "off";
    nameInput.setAttribute("aria-label", "Workspace name");

    const stackRow = document.createElement("div");
    stackRow.className = "nws-stack";
    for (const chip of template.stack) {
      const el = document.createElement("span");
      el.className = "nws-chip";
      el.textContent = chip;
      stackRow.append(el);
    }
    const debugChip = document.createElement("span");
    debugChip.className = "nws-chip nws-chip-muted";
    debugChip.textContent = "debug: auto-detected";
    stackRow.append(debugChip);

    const treeLabel = document.createElement("div");
    treeLabel.className = "nws-tree-label";
    treeLabel.textContent = "Files to create";

    const tree = document.createElement("pre");
    tree.className = "nws-tree";
    tree.textContent = template.tree.map((line) => line.text).join("\n");

    const options = document.createElement("div");
    options.className = "nws-options";

    const error = document.createElement("p");
    error.className = "nws-dialog-error";
    error.hidden = true;

    const actions = document.createElement("div");
    actions.className = "nws-dialog-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "nws-btn";
    cancelBtn.textContent = "Cancel";
    const createBtn = document.createElement("button");
    createBtn.type = "button";
    createBtn.className = "nws-btn nws-btn-confirm action-primary";
    createBtn.textContent = "Create";
    actions.append(cancelBtn, createBtn);

    dialog.append(
      title,
      pathRow,
      nameInput,
      stackRow,
      treeLabel,
      tree,
      options,
      error,
      actions,
    );
    overlay.append(dialog);
    document.body.append(overlay);

    let currentPath = initialPath;
    let settled = false;

    const finish = (value: { name: string; path: string } | null): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("keydown", onKeyDown, true);
      overlay.remove();
      resolve(value);
    };

    const renderPathRow = (
      inspection: WorkspaceTemplateInitInspection | null,
    ): void => {
      pathRow.replaceChildren();
      pathRow.append(createOriginalIcon(Folder, { size: 13 }));
      const pathText = document.createElement("span");
      pathText.className = "nws-path-text";
      pathText.textContent = currentPath;
      pathText.title = currentPath;
      pathRow.append(pathText);
      const changeBtn = document.createElement("button");
      changeBtn.type = "button";
      changeBtn.className = "nws-path-change";
      changeBtn.textContent = "Change…";
      changeBtn.addEventListener("click", () => {
        void (async () => {
          const next = await bridge.pickWorkspaceFolder();
          if (!next) return;
          currentPath = next;
          nameInput.value = folderBasename(next);
          try {
            inspection = await bridge.inspectWorkspaceInit!({
              path: currentPath,
              templateId: template.id,
            });
          } catch {
            inspection = null;
          }
          renderPathRow(inspection);
          renderOptions(inspection);
        })();
      });
      pathRow.append(changeBtn);
    };

    let inspection: WorkspaceTemplateInitInspection | null = null;

    const renderOptions = (
      inspection: WorkspaceTemplateInitInspection | null,
    ): void => {
      options.replaceChildren();

      const addRow = (
        label: string,
        desc: string,
        stateText: string,
      ): void => {
        const row = document.createElement("div");
        row.className = "nws-opt";
        const t = document.createElement("span");
        t.className = "nws-opt-t";
        t.textContent = label;
        const d = document.createElement("span");
        d.className = "nws-opt-d";
        d.textContent = desc;
        const state = document.createElement("span");
        state.className = "nws-opt-state";
        state.textContent = stateText;
        row.append(t, d, state);
        options.append(row);
      };

      addRow(
        "git init",
        "only when .git is absent — no commit created",
        inspectionStateText(
          inspection?.git,
          template.hasDeps ? "will-run" : "n-a",
        ),
      );
      if (template.hasDeps) {
        addRow(
          "npm install",
          "only when node_modules is absent — cancellable, non-fatal",
          inspectionStateText(inspection?.install, "will-run"),
        );
      }
    };

    const submit = (): void => {
      const name = nameInput.value.trim() || folderBasename(currentPath);
      finish({ name, path: currentPath });
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        finish(null);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !isImeComposing(event)) {
        event.preventDefault();
        submit();
      }
    });

    cancelBtn.addEventListener("click", () => finish(null));
    createBtn.addEventListener("click", () => submit());
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) finish(null);
    });

    // Initial state (inspection happens async so the dialog opens fast).
    nameInput.value = folderBasename(currentPath);
    renderPathRow(null);
    renderOptions(null);
    void (async () => {
      try {
        inspection = await bridge.inspectWorkspaceInit!({
          path: currentPath,
          templateId: template.id,
        });
      } catch {
        inspection = null;
      }
      if (!settled) {
        renderPathRow(inspection);
        renderOptions(inspection);
      }
    })();

    requestAnimationFrame(() => {
      nameInput.focus();
      nameInput.select();
    });
  });
}

/* ------------------------------------------------------ init progress dialog */

const STEP_LABELS: Record<WorkspaceInitStepId, string> = {
  folders: "Create folders",
  files: "Write files",
  git: "git init",
  install: "Install dependencies",
  register: "Register workspace",
};

async function runInitDialog(
  template: WorkspaceTemplateInfo,
  name: string,
  path: string,
  bridge: Bridge,
  hooks: NewWorkspaceHooks,
): Promise<void> {
  const steps: WorkspaceInitStepId[] = template.hasDeps
    ? ["folders", "files", "git", "install", "register"]
    : ["folders", "files", "register"];

  const overlay = document.createElement("div");
  overlay.className = "nws-overlay";

  const dialog = document.createElement("div");
  dialog.className = "nws-dialog nws-progress";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");

  const title = document.createElement("h2");
  title.className = "nws-dialog-title";
  title.textContent = "Creating workspace";

  const sub = document.createElement("p");
  sub.className = "nws-progress-sub";
  sub.textContent = `${name} · ${template.name}`;

  const list = document.createElement("div");
  list.className = "nws-steps";

  const rowByStep = new Map<WorkspaceInitStepId, HTMLDivElement>();
  const detailByStep = new Map<WorkspaceInitStepId, HTMLElement>();
  for (const id of steps) {
    const row = document.createElement("div");
    row.className = "nws-step";
    const mark = document.createElement("span");
    mark.className = "nws-step-mark";
    const label = document.createElement("span");
    label.className = "nws-step-label";
    label.textContent = STEP_LABELS[id];
    const detail = document.createElement("span");
    detail.className = "nws-step-detail";
    row.append(mark, label, detail);
    list.append(row);
    rowByStep.set(id, row);
    detailByStep.set(id, detail);
  }

  const summary = document.createElement("div");
  summary.className = "nws-summary";
  summary.hidden = true;

  const actions = document.createElement("div");
  actions.className = "nws-dialog-actions";
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "nws-btn";
  cancelBtn.textContent = "Cancel";
  const doneBtn = document.createElement("button");
  doneBtn.type = "button";
  doneBtn.className = "nws-btn";
  doneBtn.textContent = "Done";
  doneBtn.hidden = true;
  actions.append(cancelBtn, doneBtn);

  dialog.append(title, sub, list, summary, actions);
  overlay.append(dialog);
  document.body.append(overlay);

  let runId: string | null = null;
  let closed = false;

  const setStep = (
    id: WorkspaceInitStepId,
    state: WorkspaceInitStepState,
    detail?: string,
  ): void => {
    const row = rowByStep.get(id);
    if (!row) return;
    const mark = row.querySelector<HTMLElement>(".nws-step-mark");
    if (!mark) return;
    row.classList.remove("is-running", "is-done", "is-skipped", "is-failed");
    mark.replaceChildren();
    if (state === "running") {
      row.classList.add("is-running");
      const spinner = document.createElement("span");
      spinner.className = "nws-spinner";
      mark.append(spinner);
    } else if (state === "done") {
      row.classList.add("is-done");
      mark.append(createLucideIcon(Check, { size: 14 }));
    } else if (state === "skipped") {
      row.classList.add("is-skipped");
      mark.append(createLucideIcon(Minus, { size: 14 }));
    } else {
      row.classList.add("is-failed");
      mark.append(createLucideIcon(Minus, { size: 14 }));
    }
    if (typeof detail === "string" && detail) {
      detailByStep.get(id)!.textContent = detail;
    }
  };

  const unsubscribe = bridge.onWorkspaceInitProgress?.((progress) => {
    if (runId === null) runId = progress.runId;
    if (progress.runId !== runId) return;
    setStep(progress.step, progress.state, progress.detail);
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    overlay.remove();
  };

  const showSummary = (outcome: WorkspaceTemplateInitOutcome): void => {
    const lines: string[] = [];
    if (outcome.workspace) {
      lines.push(
        `Workspace created · ${outcome.written.length} files written` +
          (outcome.skipped.length > 0
            ? ` · ${outcome.skipped.length} skipped (existing files are never overwritten)`
            : ""),
      );
    }
    if (outcome.installRan) lines.push("Dependencies installed.");
    if (outcome.installFailed)
      lines.push("npm install failed — run it manually later.");
    if (outcome.cancelled) lines.push("Cancelled — partial init kept.");
    if (outcome.error) lines.push(`Error: ${outcome.error}`);
    summary.textContent = lines.join(" ");
    summary.hidden = false;
  };

  cancelBtn.addEventListener("click", () => {
    if (runId && bridge.cancelWorkspaceInit) {
      cancelBtn.disabled = true;
      void bridge.cancelWorkspaceInit(runId).catch(() => undefined);
    }
  });
  doneBtn.addEventListener("click", () => close());
  overlay.addEventListener("mousedown", (event) => {
    if (event.target === overlay && !doneBtn.hidden) close();
  });

  let outcome: WorkspaceTemplateInitOutcome;
  try {
    outcome = await bridge.createWorkspaceFromTemplate({
      templateId: template.id,
      name,
      path,
    });
  } catch (err) {
    outcome = {
      ok: false,
      cancelled: false,
      workspace: null,
      written: [],
      skipped: [],
      gitInited: false,
      installRan: false,
      installFailed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  showSummary(outcome);
  if (outcome.workspace) hooks.onCreated?.(outcome.workspace);
  cancelBtn.hidden = true;
  doneBtn.hidden = false;
  doneBtn.focus();
}
