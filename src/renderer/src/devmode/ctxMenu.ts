/**
 * Shared Dev Mode context menu (`.devmode-ctx-*` styles, same look as the
 * Solution Outline menu). `showDevMenu` appends one menu to <body>,
 * clamps it to the viewport and tears it down on outside pointer-down,
 * Escape or window blur.
 */
export type DevMenuItem =
  | {
      kind?: "item";
      label: string;
      /** Right-aligned muted hint (e.g. a count). */
      hint?: string;
      danger?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "sep" }
  | { kind: "label"; text: string };

export function showDevMenu(
  anchor: { x: number; y: number },
  items: DevMenuItem[],
): void {
  dismissDevMenu();

  const menu = document.createElement("div");
  menu.className = "devmode-ctx-menu";

  for (const item of items) {
    if (item.kind === "sep") {
      const sep = document.createElement("div");
      sep.className = "devmode-ctx-sep";
      menu.append(sep);
      continue;
    }
    if (item.kind === "label") {
      const label = document.createElement("div");
      label.className = "devmode-ctx-label";
      label.textContent = item.text;
      menu.append(label);
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "devmode-ctx-item";
    if (item.danger) btn.classList.add("is-danger", "action-danger", "action-danger-list");
    btn.append(document.createTextNode(item.label));
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "devmode-ctx-hint";
      hint.textContent = item.hint;
      btn.append(hint);
    }
    if (item.disabled) btn.disabled = true;
    btn.addEventListener("click", () => {
      dismissDevMenu();
      item.onSelect();
    });
    menu.append(btn);
  }

  if (menu.childElementCount === 0) return;

  document.body.append(menu);
  activeMenu = menu;

  const rect = menu.getBoundingClientRect();
  const x = Math.min(anchor.x, window.innerWidth - rect.width - 8);
  const y = Math.min(anchor.y, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  const onDown = (event: PointerEvent): void => {
    if (!menu.contains(event.target as Node)) dismissDevMenu();
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") dismissDevMenu();
  };
  const onBlur = (): void => dismissDevMenu();
  menu.addEventListener("pointerdown", (e) => e.stopPropagation(), true);
  window.addEventListener("pointerdown", onDown, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", onBlur);
  teardown = () => {
    window.removeEventListener("pointerdown", onDown, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", onBlur);
  };
}

let activeMenu: HTMLElement | null = null;
let teardown: (() => void) | null = null;

export function dismissDevMenu(): void {
  teardown?.();
  teardown = null;
  activeMenu?.remove();
  activeMenu = null;
}
