import { Check, ChevronRight, ClipboardList, Copy, Flag, X } from "lucide";
import { createLucideIcon, type IconNode } from "../../ui/originalIcons.js";
import { AppDropdown } from "../../ui/appDropdown.js";
import { bindInspectorTip } from "./inspectorTip.js";
import { collectActionEmittedRouteEvents } from "./routeEventDisplay.js";

type SchemaProperty = {
  type?: string;
  title?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  minLength?: number;
  additionalProperties?: { type?: string; minLength?: number };
  properties?: Record<string, SchemaProperty>;
  "x-ui"?: string;
  "x-enumLabels"?: Record<string, string>;
  "x-showWhen"?: Record<string, string>;
};

type ParamsSchema = {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  description?: string;
  "x-emitsRouteEvents"?: string[];
  "x-ui"?: string;
};

type RouteBindingRow = { event: string; to: string };
type TextPinBindingRow = { phase: string; to: string };
/** Compare-flag → pin row (RouteTo when[]). */
type FlagPinBindingRow = { flags: string; to: string };
/** Unified RouteTo editor row (maps to when[] or routes[] on save). */
type RouteToMappingRow = {
  source: "event" | "flag";
  key: string;
  to: string;
};

const ROUTE_TO_SOURCE_OPTIONS = [
  {
    value: "event" as const,
    label: "Event",
    description: "Route by nodeContext.routeEvent (EmitRouteEvent / fsm_route).",
    icon: Flag,
  },
  {
    value: "flag" as const,
    label: "Blackboard",
    description: "Route by Compare turn flag(s). Use && and || in expressions.",
    icon: ClipboardList,
  },
] satisfies Array<{
  value: RouteToMappingRow["source"];
  label: string;
  description: string;
  icon: IconNode;
}>;

function routeToSourceMeta(source: RouteToMappingRow["source"]) {
  return (
    ROUTE_TO_SOURCE_OPTIONS.find((o) => o.value === source) ??
    ROUTE_TO_SOURCE_OPTIONS[0]!
  );
}

let routeToSourceMenu: {
  root: HTMLDivElement;
  outsideDismiss: (ev: PointerEvent) => void;
} | null = null;

function closeRouteToSourceMenu(): void {
  if (!routeToSourceMenu) return;
  document.removeEventListener(
    "pointerdown",
    routeToSourceMenu.outsideDismiss,
    true,
  );
  routeToSourceMenu.root.remove();
  routeToSourceMenu = null;
}

function openRouteToSourceMenu(
  anchor: HTMLElement,
  current: RouteToMappingRow["source"],
  onPick: (source: RouteToMappingRow["source"]) => void,
): void {
  if (routeToSourceMenu?.root.dataset.anchorId === anchor.dataset.menuId) {
    closeRouteToSourceMenu();
    return;
  }
  closeRouteToSourceMenu();

  const root = document.createElement("div");
  root.className = "graph-editor-route-source-menu";
  // Body-level floater of the Dark-island editor — keep Dark tokens (theme.ts).
  root.setAttribute("data-dark-island", "");
  root.setAttribute("role", "menu");
  root.dataset.anchorId = anchor.dataset.menuId ?? "";

  for (const option of ROUTE_TO_SOURCE_OPTIONS) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "graph-editor-route-source-menu-item";
    if (option.value === current) item.classList.add("is-selected");
    item.setAttribute("role", "menuitemradio");
    item.setAttribute(
      "aria-checked",
      option.value === current ? "true" : "false",
    );

    const iconWrap = document.createElement("span");
    iconWrap.className = "graph-editor-route-source-menu-icon";
    iconWrap.append(createLucideIcon(option.icon, { size: 14 }));

    const textWrap = document.createElement("span");
    textWrap.className = "graph-editor-route-source-menu-text";
    const label = document.createElement("span");
    label.className = "graph-editor-route-source-menu-label";
    label.textContent = option.label;
    const desc = document.createElement("span");
    desc.className = "graph-editor-route-source-menu-desc";
    desc.textContent = option.description;
    textWrap.append(label, desc);

    item.append(iconWrap, textWrap);
    item.addEventListener("click", () => {
      closeRouteToSourceMenu();
      if (option.value !== current) onPick(option.value);
    });
    root.append(item);
  }

  document.body.append(root);
  const rect = anchor.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 4;
  const menuRect = root.getBoundingClientRect();
  if (left + menuRect.width > window.innerWidth - 8) {
    left = Math.max(8, window.innerWidth - menuRect.width - 8);
  }
  if (top + menuRect.height > window.innerHeight - 8) {
    top = Math.max(8, rect.top - menuRect.height - 4);
  }
  root.style.left = `${left}px`;
  root.style.top = `${top}px`;

  const outsideDismiss = (ev: PointerEvent) => {
    const node = ev.target;
    if (!(node instanceof Node)) return;
    if (root.contains(node) || anchor.contains(node)) return;
    closeRouteToSourceMenu();
  };
  document.addEventListener("pointerdown", outsideDismiss, true);
  routeToSourceMenu = { root, outsideDismiss };
}
type RouteGuideRow = { when: string; routeTo: string };

function normalizeBindingRows(raw: unknown): RouteBindingRow[] {
  if (Array.isArray(raw)) {
    const rows: RouteBindingRow[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const event =
        typeof (item as { event?: unknown }).event === "string"
          ? (item as { event: string }).event.trim()
          : "";
      const to =
        typeof (item as { to?: unknown }).to === "string"
          ? (item as { to: string }).to.trim()
          : typeof (item as { pin?: unknown }).pin === "string"
            ? (item as { pin: string }).pin.trim()
            : "";
      if (!event || !to) continue;
      rows.push({ event, to });
    }
    return rows;
  }
  if (raw && typeof raw === "object") {
    const rows: RouteBindingRow[] = [];
    for (const [event, to] of Object.entries(raw as Record<string, unknown>)) {
      const e = event.trim();
      if (!e || typeof to !== "string" || !to.trim()) continue;
      rows.push({ event: e, to: to.trim() });
    }
    return rows;
  }
  return [];
}

function normalizeTextPinBindingRows(raw: unknown): TextPinBindingRow[] {
  if (Array.isArray(raw)) {
    const rows: TextPinBindingRow[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const phase =
        typeof (item as { phase?: unknown }).phase === "string"
          ? (item as { phase: string }).phase.trim()
          : "";
      const to =
        typeof (item as { to?: unknown }).to === "string"
          ? (item as { to: string }).to.trim()
          : typeof (item as { pin?: unknown }).pin === "string"
            ? (item as { pin: string }).pin.trim()
            : "";
      if (!phase || !to) continue;
      rows.push({ phase, to });
    }
    return rows;
  }
  if (raw && typeof raw === "object") {
    const rows: TextPinBindingRow[] = [];
    for (const [phase, to] of Object.entries(raw as Record<string, unknown>)) {
      const p = phase.trim();
      if (!p || typeof to !== "string" || !to.trim()) continue;
      rows.push({ phase: p, to: to.trim() });
    }
    return rows;
  }
  return [];
}

function flagsFromWhenRow(row: Record<string, unknown>): string {
  if (typeof row.expr === "string" && row.expr.trim()) {
    return row.expr.trim();
  }
  if (Array.isArray(row.allOf)) {
    return row.allOf
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .join(" && ");
  }
  if (typeof row.key === "string") return row.key.trim();
  return "";
}

function whenRowFromFlags(flags: string, to: string): Record<string, unknown> {
  const expr = flags.trim();
  if (!expr) return { expr: "", to };
  return { expr, to };
}

function whenRowPin(row: Record<string, unknown>): string {
  if (typeof row.to === "string" && row.to.trim()) return row.to.trim();
  if (typeof row.pin === "string" && row.pin.trim()) return row.pin.trim();
  return "";
}

function routeToMappingRowsFromParams(
  params: Record<string, unknown>,
): RouteToMappingRow[] {
  const rows: RouteToMappingRow[] = [];
  if (Array.isArray(params.when)) {
    for (const item of params.when) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      rows.push({
        source: "flag",
        key: flagsFromWhenRow(row),
        to: whenRowPin(row),
      });
    }
  }
  for (const binding of normalizeBindingRows(params.routes)) {
    rows.push({ source: "event", key: binding.event, to: binding.to });
  }
  return rows;
}

function routeToParamsFromMappingRows(rows: RouteToMappingRow[]): {
  when?: Record<string, unknown>[];
  routes?: { event: string; to: string }[];
} {
  const when: Record<string, unknown>[] = [];
  const routes: { event: string; to: string }[] = [];
  for (const row of rows) {
    if (!row.key.trim() || !row.to.trim()) continue;
    if (row.source === "flag") {
      when.push(whenRowFromFlags(row.key, row.to));
    } else {
      routes.push({ event: row.key.trim(), to: row.to.trim() });
    }
  }
  return {
    ...(when.length > 0 ? { when } : {}),
    ...(routes.length > 0 ? { routes } : {}),
  };
}

function normalizeFlagPinBindingRows(raw: unknown): FlagPinBindingRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: FlagPinBindingRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    const flags = flagsFromWhenRow(row);
    const to =
      typeof row.to === "string" && row.to.trim()
        ? row.to.trim()
        : typeof row.pin === "string" && row.pin.trim()
          ? row.pin.trim()
          : "";
    if (!flags || !to) continue;
    rows.push({ flags, to });
  }
  return rows;
}

function normalizeGuideRows(raw: unknown): RouteGuideRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: RouteGuideRow[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    rows.push({
      when:
        typeof (item as { when?: unknown }).when === "string"
          ? (item as { when: string }).when
          : "",
      routeTo:
        typeof (item as { routeTo?: unknown }).routeTo === "string"
          ? (item as { routeTo: string }).routeTo
          : "",
    });
  }
  return rows;
}

/** Single-line preview for a collapsed textarea (first non-empty line). */
function collapsePreviewLine(value: string): string {
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function isShown(
  prop: SchemaProperty,
  params: Record<string, unknown>,
): boolean {
  if (prop["x-ui"] === "hidden") return false;
  const when = prop["x-showWhen"];
  if (!when) return true;
  for (const [key, expected] of Object.entries(when)) {
    if (String(params[key] ?? "") !== expected) return false;
  }
  return true;
}

/** Prefer an explicit param; otherwise the schema default (matches runtime). */
function effectiveParam(
  params: Record<string, unknown>,
  key: string,
  prop: SchemaProperty,
): unknown {
  if (Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined) {
    return params[key];
  }
  return prop.default;
}

export type ParamsFormMountOptions = {
  /** Event names for `x-ui: "route-bindings"` (scanned from sibling Actions). */
  routeEventOptions?: string[];
};

/** Schema-driven Action params form (pin-select uses node pin names). */
export class ParamsFormView {
  private host: HTMLElement | null = null;
  private onChange: ((params: Record<string, unknown>) => void) | null = null;
  private schema: ParamsSchema | null = null;
  private pinNames: string[] = [];
  private routeEventOptions: string[] = [];
  private params: Record<string, unknown> = {};
  /**
   * Collapsible-textarea keys the user expanded this mount. Cleared on every
   * mount so those fields render collapsed by default (empty or not) and only
   * open via their toggle; committing an empty value auto-collapses again.
   */
  private expandedCollapseKeys = new Set<string>();

  mount(
    host: HTMLElement,
    schema: ParamsSchema,
    params: Record<string, unknown>,
    pinNames: string[],
    onChange: (params: Record<string, unknown>) => void,
    options?: ParamsFormMountOptions,
  ): void {
    this.host = host;
    this.onChange = onChange;
    this.schema = schema;
    this.pinNames = pinNames;
    this.routeEventOptions = options?.routeEventOptions ?? [];
    this.params = { ...params };
    this.expandedCollapseKeys.clear();
    this.render();
  }

  destroy(): void {
    closeRouteToSourceMenu();
    this.onChange = null;
    this.host = null;
    this.schema = null;
    this.pinNames = [];
    this.routeEventOptions = [];
    this.params = {};
    this.expandedCollapseKeys.clear();
  }

  private render(): void {
    closeRouteToSourceMenu();
    const host = this.host;
    const schema = this.schema;
    if (!host || !schema) return;
    host.replaceChildren();

    const emitted = collectActionEmittedRouteEvents(
      schema as Record<string, unknown>,
      this.params,
    );
    if (emitted.length > 0) {
      host.append(this.emitsEventsBlock(emitted));
    }

    if (schema["x-ui"] === "route-to") {
      host.append(this.routeToMappingsBlock());
      return;
    }

    const props = schema.properties ?? {};
    const keys = Object.keys(props).filter((key) =>
      isShown(props[key]!, this.params),
    );
    if (keys.length === 0) {
      if (emitted.length === 0) {
        const note = document.createElement("p");
        note.className = "graph-editor-muted";
        note.textContent = "No parameters.";
        host.append(note);
      }
      return;
    }

    for (const key of keys) {
      const prop = props[key]!;
      host.append(this.fieldRow(key, prop));
    }
  }

  private emitsEventsBlock(events: string[]): HTMLElement {
    const block = document.createElement("div");
    block.className = "graph-editor-emits-events";

    const label = document.createElement("span");
    label.className = "graph-editor-emits-events-label";
    label.textContent = "Emits events";
    bindInspectorTip(
      label,
      "Route event keys this Action may write to nodeContext.routeEvent for RouteTo.",
    );

    const list = document.createElement("div");
    list.className = "graph-editor-emits-events-list";
    for (const event of events) {
      list.append(this.emitsEventChip(event));
    }

    block.append(label, list);
    return block;
  }

  private emitsEventChip(event: string): HTMLButtonElement {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "graph-editor-emits-event-chip";
    chip.setAttribute("aria-label", `Copy event name ${event}`);
    chip.title = "Copy event name";

    const name = document.createElement("code");
    name.className = "graph-editor-emits-event-name";
    name.textContent = event;

    const copyIcon = document.createElement("span");
    copyIcon.className = "graph-editor-emits-event-copy";
    copyIcon.append(createLucideIcon(Copy, { size: 12 }));

    chip.append(name, copyIcon);
    chip.addEventListener("click", () => {
      void navigator.clipboard.writeText(event).then(() => {
        copyIcon.replaceChildren(createLucideIcon(Check, { size: 12 }));
        window.setTimeout(() => {
          copyIcon.replaceChildren(createLucideIcon(Copy, { size: 12 }));
        }, 1500);
      });
    });
    return chip;
  }

  private routeToMappingsBlock(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "graph-editor-route-to";

    const rows = routeToMappingRowsFromParams(this.params);
    const pinNames = this.pinNames;
    const eventOptions = this.eventOptionsFor(
      rows
        .filter((r) => r.source === "event")
        .map((r) => ({ event: r.key, to: r.to })),
    );

    const header = document.createElement("div");
    header.className = "graph-editor-route-to-header";
    const srcHead = document.createElement("span");
    srcHead.className = "graph-editor-route-to-header-src";
    srcHead.setAttribute("aria-hidden", "true");
    const keyHead = document.createElement("span");
    keyHead.textContent = "Condition";
    const pinHead = document.createElement("span");
    pinHead.textContent = "Pin";
    const rmHead = document.createElement("span");
    rmHead.setAttribute("aria-hidden", "true");
    header.append(srcHead, keyHead, pinHead, rmHead);
    wrap.append(header);

    const list = document.createElement("div");
    list.className = "graph-editor-route-to-rows";
    for (let i = 0; i < rows.length; i++) {
      list.append(
        this.routeToMappingRow(rows, i, rows[i]!, pinNames, eventOptions),
      );
    }
    wrap.append(list);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "graph-editor-route-add";
    add.textContent = "Add mapping";
    add.addEventListener("click", () => {
      const next = [
        ...rows,
        {
          source: "event" as const,
          key: eventOptions[0] ?? "stay",
          to: pinNames[0] ?? "",
        },
      ];
      this.patchRouteToMappings(next);
    });
    const footer = document.createElement("div");
    footer.className = "graph-editor-route-to-footer";
    footer.append(add);
    wrap.append(footer);

    const hasBlackboardRows =
      rows.some((r) => r.source === "flag") ||
      (Array.isArray(this.params.when) && this.params.when.length > 0);
    if (hasBlackboardRows) {
      const options = document.createElement("div");
      options.className = "graph-editor-route-to-options";
      options.append(
        this.routeToOnlyIfUnsetRow(),
        this.routeToDefaultPinRow(pinNames),
      );
      wrap.append(options);
    }

    return wrap;
  }

  private routeToDefaultPinRow(pinNames: string[]): HTMLElement {
    const row = document.createElement("label");
    row.className = "graph-editor-row";
    const label = document.createElement("span");
    label.className = "graph-editor-row-label";
    label.textContent = "Default pin";
    bindInspectorTip(
      label,
      "When no blackboard row matches and routeTarget is unset, route here.",
    );
    const current =
      typeof this.params.defaultPin === "string" ? this.params.defaultPin : "";
    const select = this.pinDropdown(pinNames, current, "(none)", (value) => {
      const next = { ...this.params };
      if (value) next.defaultPin = value;
      else delete next.defaultPin;
      this.params = next;
      this.onChange?.(next);
      this.render();
    });
    row.append(label, select.el);
    return row;
  }

  private routeToOnlyIfUnsetRow(): HTMLElement {
    const row = document.createElement("label");
    row.className = "graph-editor-row graph-editor-row-check";
    const label = document.createElement("span");
    label.className = "graph-editor-row-label";
    label.textContent = "Only if route unset";
    bindInspectorTip(
      label,
      "Blackboard rows only: skip flag routing when nodeContext.routeTarget is already set.",
    );
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = this.params.onlyIfRouteTargetUnset === true;
    checkbox.addEventListener("change", () => {
      const next = { ...this.params };
      if (checkbox.checked) next.onlyIfRouteTargetUnset = true;
      else delete next.onlyIfRouteTargetUnset;
      this.params = next;
      this.onChange?.(next);
      this.render();
    });
    row.append(label, checkbox);
    return row;
  }

  private routeToMappingRow(
    rows: RouteToMappingRow[],
    index: number,
    mapping: RouteToMappingRow,
    pinNames: string[],
    eventOptions: string[],
  ): HTMLElement {
    const line = document.createElement("div");
    line.className = "graph-editor-route-to-row";

    const sourceBtn = this.routeToSourcePicker(mapping.source, (source) => {
      const next = rows.map((r, i) =>
        i === index
          ? {
              ...r,
              source,
              key:
                source === "event" ? (eventOptions[0] ?? "stay") : r.key,
            }
          : r,
      );
      this.patchRouteToMappings(next);
    });

    const keyControl =
      mapping.source === "event"
        ? this.routeToEventKeyControl(
            mapping.key,
            eventOptions,
            (key) => {
              const next = rows.map((r, i) =>
                i === index ? { ...r, key } : r,
              );
              this.patchRouteToMappings(next);
            },
          )
        : this.routeToFlagKeyControl(mapping.key, (key) => {
            const next = rows.map((r, i) =>
              i === index ? { ...r, key } : r,
            );
            this.patchRouteToMappings(next);
          });

    const pinSelect = this.pinDropdown(
      pinNames,
      mapping.to,
      "(pin)",
      (value) => {
        const next = rows.map((r, i) =>
          i === index ? { ...r, to: value } : r,
        );
        this.patchRouteToMappings(next);
      },
      "Target pin",
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "graph-editor-route-remove";
    remove.append(createLucideIcon(X, { size: 12 }));
    remove.setAttribute("aria-label", "Remove");
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      this.patchRouteToMappings(rows.filter((_, i) => i !== index));
    });

    line.append(sourceBtn, keyControl, pinSelect.el, remove);
    return line;
  }

  private routeToSourcePicker(
    current: RouteToMappingRow["source"],
    onPick: (source: RouteToMappingRow["source"]) => void,
  ): HTMLButtonElement {
    const meta = routeToSourceMeta(current);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "graph-editor-route-source-btn";
    btn.title = meta.label;
    btn.dataset.menuId = `route-source-${Math.random().toString(36).slice(2, 9)}`;
    btn.setAttribute("aria-label", `Source: ${meta.label}`);
    btn.setAttribute("aria-haspopup", "menu");
    btn.append(createLucideIcon(meta.icon, { size: 14 }));
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openRouteToSourceMenu(btn, current, onPick);
    });
    return btn;
  }

  private routeToEventKeyControl(
    value: string,
    eventOptions: string[],
    onChange: (key: string) => void,
  ): HTMLElement {
    const entries = eventOptions.map((event) => ({
      value: event,
      label: event,
    }));
    if (value && !eventOptions.includes(value)) {
      entries.push({ value, label: value });
    }
    return this.dropdownControl(entries, value, onChange, "Route event").el;
  }

  private routeToFlagKeyControl(
    value: string,
    onChange: (key: string) => void,
  ): HTMLElement {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "graph-editor-control";
    input.placeholder = "flag || other && x";
    input.title =
      "Boolean expression over turn flags. && = AND, || = OR. Rows are tried top-to-bottom (first match).";
    input.value = value;
    input.addEventListener("change", () => {
      onChange(input.value.trim());
    });
    return input;
  }

  private patchRouteToMappings(rows: RouteToMappingRow[]): void {
    const split = routeToParamsFromMappingRows(rows);
    const next = { ...this.params };
    if (split.when) next.when = split.when;
    else delete next.when;
    if (split.routes) next.routes = split.routes;
    else delete next.routes;
    if (!Array.isArray(next.when) || next.when.length === 0) {
      delete next.onlyIfRouteTargetUnset;
      delete next.defaultPin;
    }
    this.params = next;
    this.onChange?.(next);
    this.render();
  }

  /**
   * Dropdown over flat options. A `current` value outside `options` is kept as
   * an extra row so stale graph values stay visible instead of silently
   * resetting to the first entry.
   */
  private dropdownControl(
    entries: Array<{ value: string; label: string }>,
    current: string,
    onChange: (value: string) => void,
    title?: string,
  ): AppDropdown {
    const dropdown = new AppDropdown(entries, current, {
      className: "graph-editor-control",
    });
    if (title) dropdown.el.title = title;
    dropdown.addEventListener("change", () => onChange(dropdown.value));
    return dropdown;
  }

  /** Pin picker: an empty-value placeholder row plus one row per pin name. */
  private pinDropdown(
    pins: string[],
    current: string,
    placeholder: string,
    onChange: (value: string) => void,
    title?: string,
  ): AppDropdown {
    const entries = [
      { value: "", label: placeholder },
      ...pins.map((pin) => ({ value: pin, label: pin })),
    ];
    if (current && !pins.includes(current)) {
      entries.push({ value: current, label: current });
    }
    return this.dropdownControl(entries, current, onChange, title);
  }

  private fieldRow(key: string, prop: SchemaProperty): HTMLElement {
    const row = document.createElement("label");
    row.className = "graph-editor-row";

    const label = document.createElement("span");
    label.className = "graph-editor-row-label";
    label.textContent = prop.title ?? key;
    bindInspectorTip(label, prop.description);

    const ui = prop["x-ui"];
    const params = this.params;
    const pinNames = this.pinNames;

    if (ui === "pin-select") {
      const current =
        typeof params[key] === "string" ? (params[key] as string) : "";
      const select = this.pinDropdown(
        pinNames,
        current,
        "(unbound)",
        (value) => this.patch(key, value || undefined),
      );
      row.append(label, select.el);
      return row;
    }

    if (ui === "route-bindings") {
      row.classList.add("is-stack");
      const stack = document.createElement("div");
      stack.className = "graph-editor-route-bindings";
      const rows = normalizeBindingRows(params[key]);
      const eventOptions = this.eventOptionsFor(rows);

      for (let i = 0; i < rows.length; i++) {
        const binding = rows[i]!;
        stack.append(this.routeBindingRow(key, rows, i, binding, eventOptions));
      }

      const add = document.createElement("button");
      add.type = "button";
      add.className = "graph-editor-route-add";
      add.textContent = "Add route";
      add.addEventListener("click", () => {
        const next = [
          ...rows,
          {
            event: eventOptions[0] ?? "stay",
            to: pinNames[0] ?? "",
          },
        ];
        this.patch(key, next.filter((r) => r.event && r.to));
      });
      stack.append(add);
      row.append(label, stack);
      return row;
    }

    if (ui === "text-pin-bindings") {
      row.classList.add("is-stack");
      const stack = document.createElement("div");
      stack.className = "graph-editor-route-bindings";
      const rows = normalizeTextPinBindingRows(params[key]);

      for (let i = 0; i < rows.length; i++) {
        stack.append(this.textPinBindingRow(key, rows, i, rows[i]!, pinNames));
      }

      const add = document.createElement("button");
      add.type = "button";
      add.className = "graph-editor-route-add";
      add.textContent = "Add phase";
      add.addEventListener("click", () => {
        const next = [
          ...rows,
          {
            phase: "",
            to: pinNames[0] ?? "",
          },
        ];
        this.patch(key, next);
      });
      stack.append(add);
      row.append(label, stack);
      return row;
    }

    if (ui === "flag-pin-bindings") {
      row.classList.add("is-stack");
      const stack = document.createElement("div");
      stack.className = "graph-editor-route-bindings";
      const rows = normalizeFlagPinBindingRows(params[key]);

      if (rows.length > 0) {
        const header = document.createElement("div");
        header.className = "graph-editor-route-guide-header";
        const flagsHead = document.createElement("span");
        flagsHead.textContent = "Condition (&& / ||)";
        const pinHead = document.createElement("span");
        pinHead.textContent = "Pin";
        header.append(flagsHead, pinHead);
        stack.append(header);
      }

      for (let i = 0; i < rows.length; i++) {
        stack.append(this.flagPinBindingRow(key, rows, i, rows[i]!, pinNames));
      }

      const add = document.createElement("button");
      add.type = "button";
      add.className = "graph-editor-route-add";
      add.textContent = "Add when";
      add.addEventListener("click", () => {
        const next = [
          ...rows.map((r) => whenRowFromFlags(r.flags, r.to)),
          whenRowFromFlags("", pinNames[0] ?? ""),
        ];
        this.patch(key, next);
      });
      stack.append(add);
      row.append(label, stack);
      return row;
    }

    if (ui === "route-guide") {
      row.classList.add("is-stack");
      const stack = document.createElement("div");
      stack.className = "graph-editor-route-guide";
      const rows = normalizeGuideRows(params[key]);

      const header = document.createElement("div");
      header.className = "graph-editor-route-guide-header";
      const whenHead = document.createElement("span");
      whenHead.textContent = "When";
      const eventHead = document.createElement("span");
      eventHead.textContent = "Event";
      header.append(whenHead, eventHead);
      if (rows.length > 0) stack.append(header);

      for (let i = 0; i < rows.length; i++) {
        stack.append(this.routeGuideRow(key, rows, i, rows[i]!));
      }

      const add = document.createElement("button");
      add.type = "button";
      add.className = "graph-editor-route-add";
      add.textContent = "Add guide row";
      add.addEventListener("click", () => {
        this.patch(key, [...rows, { when: "", routeTo: "" }]);
      });
      stack.append(add);
      row.append(label, stack);
      return row;
    }

    // Nested object fields (structured param groups) — must run before
    // the generic text fallback, or objects become "[object Object]".
    const nestedProps =
      prop.properties &&
      typeof prop.properties === "object" &&
      !Array.isArray(prop.properties)
        ? prop.properties
        : null;
    if (
      ui === "object-fields" ||
      (prop.type === "object" &&
        nestedProps &&
        Object.keys(nestedProps).length > 0 &&
        ui !== "pin-map" &&
        ui !== "text-pin-bindings" &&
        ui !== "flag-pin-bindings")
    ) {
      row.classList.add("is-stack");
      const stack = document.createElement("div");
      stack.className = "graph-editor-nested-params";
      const nestedRaw = params[key];
      const nestedParams: Record<string, unknown> =
        nestedRaw &&
        typeof nestedRaw === "object" &&
        !Array.isArray(nestedRaw)
          ? { ...(nestedRaw as Record<string, unknown>) }
          : {};

      const patchNested = (nk: string, value: unknown): void => {
        const next = { ...nestedParams };
        if (value === undefined) delete next[nk];
        else next[nk] = value;
        this.patch(key, Object.keys(next).length > 0 ? next : undefined);
      };

      for (const [nk, nprop] of Object.entries(nestedProps ?? {})) {
        if (!isShown(nprop, nestedParams)) continue;

        if (nprop.type === "boolean" || nprop["x-ui"] === "toggle") {
          const nestRow = document.createElement("label");
          nestRow.className = "graph-editor-row graph-editor-row-check";
          const nestLabel = document.createElement("span");
          nestLabel.className = "graph-editor-row-label";
          nestLabel.textContent = nprop.title ?? nk;
          bindInspectorTip(nestLabel, nprop.description);
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = effectiveParam(nestedParams, nk, nprop) === true;
          checkbox.addEventListener("change", () => {
            patchNested(nk, checkbox.checked);
          });
          nestRow.append(nestLabel, checkbox);
          stack.append(nestRow);
          continue;
        }

        if (
          (nprop["x-ui"] === "select" || Array.isArray(nprop.enum)) &&
          Array.isArray(nprop.enum) &&
          nprop.enum.length > 0
        ) {
          const nestRow = document.createElement("label");
          nestRow.className = "graph-editor-row";
          const nestLabel = document.createElement("span");
          nestLabel.className = "graph-editor-row-label";
          nestLabel.textContent = nprop.title ?? nk;
          bindInspectorTip(nestLabel, nprop.description);
          const labels = nprop["x-enumLabels"] ?? {};
          const cur = effectiveParam(nestedParams, nk, nprop);
          const current = cur !== undefined && cur !== null ? String(cur) : "";
          const select = this.dropdownControl(
            [
              { value: "", label: "(unset)" },
              ...nprop.enum.map((value) => ({
                value: String(value),
                label: labels[String(value)] ?? String(value),
              })),
            ],
            current,
            (value) => patchNested(nk, value || undefined),
          );
          nestRow.append(nestLabel, select.el);
          stack.append(nestRow);
        }
      }

      if (stack.childElementCount === 0) {
        const empty = document.createElement("p");
        empty.className = "graph-editor-muted";
        empty.textContent = "No nested fields.";
        stack.append(empty);
      }
      row.append(label, stack);
      return row;
    }

    if (ui === "pin-map") {
      const textarea = document.createElement("textarea");
      textarea.className = "graph-editor-control graph-editor-textarea";
      textarea.rows = 3;
      textarea.placeholder = '{"role": "pin_name"}';
      const map = params[key];
      textarea.value =
        map && typeof map === "object" && !Array.isArray(map)
          ? JSON.stringify(map, null, 2)
          : "{}";
      textarea.addEventListener("change", () => {
        try {
          const parsed = JSON.parse(textarea.value || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            this.patch(key, parsed);
          }
        } catch {
          // keep previous until valid JSON
        }
      });
      row.classList.add("is-stack");
      row.append(label, textarea);
      return row;
    }

    if (prop.type === "boolean" || ui === "toggle") {
      row.classList.add("graph-editor-row-check");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = effectiveParam(params, key, prop) === true;
      checkbox.addEventListener("change", () => {
        this.patch(key, checkbox.checked);
      });
      row.append(label, checkbox);
      return row;
    }

    if (prop.type === "integer" || prop.type === "number" || ui === "number") {
      const input = document.createElement("input");
      input.type = "number";
      input.className = "graph-editor-control";
      if (prop.type === "integer") input.step = "1";
      const current = effectiveParam(params, key, prop);
      input.value =
        typeof current === "number" && Number.isFinite(current)
          ? String(current)
          : typeof current === "string" && current.trim()
            ? current
            : "";
      input.addEventListener("change", () => {
        const raw = input.value.trim();
        if (!raw) {
          this.patch(key, undefined);
          return;
        }
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        this.patch(key, prop.type === "integer" ? Math.trunc(n) : n);
      });
      row.append(label, input);
      return row;
    }

    if (ui === "select" && Array.isArray(prop.enum) && prop.enum.length > 0) {
      const labels = prop["x-enumLabels"] ?? {};
      const raw =
        params[key] !== undefined ? String(params[key]) : String(prop.enum[0]);
      const current = prop.enum.map(String).includes(raw)
        ? raw
        : String(prop.enum[0]);
      const select = this.dropdownControl(
        prop.enum.map((value) => ({
          value: String(value),
          label: labels[String(value)] ?? String(value),
        })),
        current,
        (value) => this.patch(key, value),
      );
      row.append(label, select.el);
      return row;
    }

    if (ui === "collapsible-textarea") {
      return this.collapsibleTextareaRow(key, label);
    }

    if (ui === "textarea") {
      const textarea = document.createElement("textarea");
      textarea.className = "graph-editor-control graph-editor-textarea";
      textarea.rows = 4;
      textarea.value = typeof params[key] === "string" ? params[key] : "";
      textarea.addEventListener("change", () => {
        this.patch(key, textarea.value);
      });
      row.classList.add("is-stack");
      row.append(label, textarea);
      return row;
    }

    // Object without a nested schema — editable JSON (never String(obj)).
    if (prop.type === "object") {
      const textarea = document.createElement("textarea");
      textarea.className = "graph-editor-control graph-editor-textarea";
      textarea.rows = 4;
      const raw = params[key];
      textarea.value =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? JSON.stringify(raw, null, 2)
          : "{}";
      textarea.addEventListener("change", () => {
        try {
          const parsed = JSON.parse(textarea.value || "{}");
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            this.patch(key, parsed);
          }
        } catch {
          // keep previous until valid JSON
        }
      });
      row.classList.add("is-stack");
      row.append(label, textarea);
      return row;
    }

    const input = document.createElement("input");
    input.type = "text";
    input.className = "graph-editor-control";
    input.value = params[key] !== undefined ? String(params[key]) : "";
    input.addEventListener("change", () => {
      const raw = input.value;
      this.patch(key, raw.length > 0 ? raw : undefined);
    });
    row.append(label, input);
    return row;
  }

  /**
   * `x-ui: "collapsible-textarea"` — one-line toggle row that expands into a
   * textarea. Collapsed by default whether or not a value exists (the row
   * previews the first line when set); toggle opens/closes with a smooth
   * height transition, and committing an empty value auto-collapses.
   */
  private collapsibleTextareaRow(
    key: string,
    label: HTMLElement,
  ): HTMLElement {
    const current =
      typeof this.params[key] === "string" ? (this.params[key] as string) : "";

    const open = this.expandedCollapseKeys.has(key);
    const wrap = document.createElement("div");
    wrap.className = "graph-editor-collapse";
    if (open) wrap.classList.add("is-open");

    const head = document.createElement("div");
    head.className = "graph-editor-collapse-head";

    label.classList.add("graph-editor-collapse-label");

    const preview = document.createElement("span");
    preview.className = "graph-editor-collapse-preview";
    preview.textContent = collapsePreviewLine(current);
    preview.hidden = current.trim().length === 0;

    // Only the arrow toggles — the label/preview row stays inert.
    const arrow = document.createElement("button");
    arrow.type = "button";
    arrow.className = "graph-editor-collapse-arrow";
    arrow.setAttribute("aria-expanded", open ? "true" : "false");
    arrow.title = open ? "Collapse" : "Expand";

    const chevron = document.createElement("span");
    chevron.className = "graph-editor-collapse-chevron";
    chevron.append(createLucideIcon(ChevronRight, { size: 14 }));
    arrow.append(chevron);

    arrow.addEventListener("click", () => {
      const next = !wrap.classList.contains("is-open");
      wrap.classList.toggle("is-open", next);
      arrow.setAttribute("aria-expanded", next ? "true" : "false");
      arrow.title = next ? "Collapse" : "Expand";
      if (next) this.expandedCollapseKeys.add(key);
      else this.expandedCollapseKeys.delete(key);
    });

    head.append(label, preview, arrow);

    const body = document.createElement("div");
    body.className = "graph-editor-collapse-body";
    const bodyInner = document.createElement("div");
    bodyInner.className = "graph-editor-collapse-body-inner";

    const textarea = document.createElement("textarea");
    textarea.className = "graph-editor-control graph-editor-textarea";
    textarea.rows = 4;
    textarea.value = current;
    textarea.addEventListener("change", () => {
      const raw = textarea.value;
      if (raw.trim().length === 0) this.expandedCollapseKeys.delete(key);
      else this.expandedCollapseKeys.add(key);
      this.patch(key, raw.trim().length > 0 ? raw : undefined);
    });

    bodyInner.append(textarea);
    body.append(bodyInner);
    wrap.append(head, body);
    return wrap;
  }

  private eventOptionsFor(rows: RouteBindingRow[]): string[] {
    const set = new Set(this.routeEventOptions);
    for (const row of rows) {
      if (row.event) set.add(row.event);
    }
    if (set.size === 0) {
      set.add("stay");
      set.add("leave");
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  private routeGuideRow(
    key: string,
    rows: RouteGuideRow[],
    index: number,
    guide: RouteGuideRow,
  ): HTMLElement {
    const line = document.createElement("div");
    line.className = "graph-editor-route-guide-row";

    const whenInput = document.createElement("input");
    whenInput.type = "text";
    whenInput.className = "graph-editor-control";
    whenInput.placeholder = "condition for the model…";
    whenInput.title = "When";
    whenInput.value = guide.when;
    whenInput.addEventListener("change", () => {
      const next = rows.map((r, i) =>
        i === index ? { ...r, when: whenInput.value } : r,
      );
      this.patch(key, next);
    });

    const eventInput = document.createElement("input");
    eventInput.type = "text";
    eventInput.className = "graph-editor-control";
    eventInput.placeholder = "event";
    eventInput.title = "fsm_route event";
    eventInput.value = guide.routeTo;
    eventInput.addEventListener("change", () => {
      const next = rows.map((r, i) =>
        i === index ? { ...r, routeTo: eventInput.value.trim() } : r,
      );
      this.patch(key, next);
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "graph-editor-route-remove";
    remove.append(createLucideIcon(X, { size: 12 }));
    remove.setAttribute("aria-label", "Remove");
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      this.patch(
        key,
        rows.filter((_, i) => i !== index),
      );
    });

    line.append(whenInput, eventInput, remove);
    return line;
  }

  private routeBindingRow(
    key: string,
    rows: RouteBindingRow[],
    index: number,
    binding: RouteBindingRow,
    eventOptions: string[],
  ): HTMLElement {
    const line = document.createElement("div");
    line.className = "graph-editor-route-binding-row";

    const eventEntries = eventOptions.map((event) => ({
      value: event,
      label: event,
    }));
    if (!eventOptions.includes(binding.event) && binding.event) {
      eventEntries.push({ value: binding.event, label: binding.event });
    }
    const eventSelect = this.dropdownControl(
      eventEntries,
      binding.event,
      (value) => {
        const next = rows.map((r, i) =>
          i === index ? { ...r, event: value } : r,
        );
        this.patch(key, next);
      },
      "Event",
    );

    const pinSelect = this.pinDropdown(
      this.pinNames,
      binding.to,
      "(pin)",
      (value) => {
        const next = rows.map((r, i) =>
          i === index ? { ...r, to: value } : r,
        );
        this.patch(
          key,
          next.filter((r) => r.event && r.to),
        );
      },
      "Target pin",
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "graph-editor-route-remove";
    remove.append(createLucideIcon(X, { size: 12 }));
    remove.setAttribute("aria-label", "Remove");
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      const next = rows.filter((_, i) => i !== index);
      this.patch(key, next);
    });

    line.append(eventSelect.el, pinSelect.el, remove);
    return line;
  }

  private textPinBindingRow(
    key: string,
    rows: TextPinBindingRow[],
    index: number,
    binding: TextPinBindingRow,
    pinNames: string[],
  ): HTMLElement {
    const line = document.createElement("div");
    line.className = "graph-editor-route-binding-row";

    const phaseInput = document.createElement("input");
    phaseInput.type = "text";
    phaseInput.className = "graph-editor-control";
    phaseInput.placeholder = "phase";
    phaseInput.title = "Phase";
    phaseInput.value = binding.phase;
    phaseInput.addEventListener("change", () => {
      const next = rows.map((r, i) =>
        i === index ? { ...r, phase: phaseInput.value.trim() } : r,
      );
      this.patch(
        key,
        next.filter((r) => r.phase && r.to),
      );
    });

    const pinSelect = this.pinDropdown(
      pinNames,
      binding.to,
      "(pin)",
      (value) => {
        const next = rows.map((r, i) =>
          i === index ? { ...r, to: value } : r,
        );
        this.patch(
          key,
          next.filter((r) => r.phase && r.to),
        );
      },
      "Target pin",
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "graph-editor-route-remove";
    remove.append(createLucideIcon(X, { size: 12 }));
    remove.setAttribute("aria-label", "Remove");
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      this.patch(
        key,
        rows.filter((_, i) => i !== index),
      );
    });

    line.append(phaseInput, pinSelect.el, remove);
    return line;
  }

  private flagPinBindingRow(
    key: string,
    rows: FlagPinBindingRow[],
    index: number,
    binding: FlagPinBindingRow,
    pinNames: string[],
  ): HTMLElement {
    const line = document.createElement("div");
    line.className = "graph-editor-route-binding-row";

    const flagsInput = document.createElement("input");
    flagsInput.type = "text";
    flagsInput.className = "graph-editor-control";
    flagsInput.placeholder = "flag || other && x";
    flagsInput.title =
      "Boolean expression over turn flags. && = AND, || = OR. Rows are tried top-to-bottom (first match).";
    flagsInput.value = binding.flags;
    flagsInput.addEventListener("change", () => {
      const next = rows.map((r, i) =>
        i === index ? { ...r, flags: flagsInput.value.trim() } : r,
      );
      this.patch(
        key,
        next
          .filter((r) => r.flags && r.to)
          .map((r) => whenRowFromFlags(r.flags, r.to)),
      );
    });

    const pinSelect = this.pinDropdown(
      pinNames,
      binding.to,
      "(pin)",
      (value) => {
        const next = rows.map((r, i) =>
          i === index ? { ...r, to: value } : r,
        );
        this.patch(
          key,
          next
            .filter((r) => r.flags && r.to)
            .map((r) => whenRowFromFlags(r.flags, r.to)),
        );
      },
      "Target pin",
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "graph-editor-route-remove";
    remove.append(createLucideIcon(X, { size: 12 }));
    remove.setAttribute("aria-label", "Remove");
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      this.patch(
        key,
        rows
          .filter((_, i) => i !== index)
          .map((r) => whenRowFromFlags(r.flags, r.to)),
      );
    });

    line.append(flagsInput, pinSelect.el, remove);
    return line;
  }

  private patch(key: string, value: unknown): void {
    const next = { ...this.params };
    if (value === undefined) delete next[key];
    else next[key] = value;

    this.params = next;
    this.onChange?.(next);
    this.render();
  }
}
