import { icon } from "./icons.js";
import { cardHeaderIcon } from "./cardHeaderIcons.js";
import { bindRowReorder, syncProviderRows } from "./tokenHubReorder.js";
import type {
  DeviceSyncMcpServer,
  McpHubController,
  McpHubServer,
  McpHubSnapshot,
  McpTransportDraft,
} from "./McpHubController.js";
// token-hub.css is imported by main.ts so this module stays DOM-testable
// under node:test (no CSS pipeline there).

type AttrValue = string | boolean | undefined | ((event: Event) => void);

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, AttrValue> = {},
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "function") node.addEventListener(key.replace(/^on/, ""), value as EventListener);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else if (value !== undefined) node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    if (typeof child === "string") {
      if (child.startsWith("<svg")) {
        const template = document.createElement("template");
        template.innerHTML = child;
        node.append(template.content);
      } else node.append(document.createTextNode(child));
    } else node.append(child);
  }
  return node;
}

function switchControl(checked: boolean, label: string, onChange: (checked: boolean) => void): HTMLElement {
  const input = h("input", { type: "checkbox", "aria-label": label }) as HTMLInputElement;
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "th-switch" }, input, h("span", { class: "th-switch-track" }));
}

function statusChip(label: string, kind: "ok" | "warn" | "muted"): HTMLElement {
  return h("span", { class: `th-status is-${kind}` }, label);
}

function reportFailure(reason: unknown): void {
  window.alert(reason instanceof Error ? reason.message : String(reason));
}

function transportIcon(type: "stdio" | "http"): HTMLElement {
  return h("span", { class: "mcp-transport-mark" }, icon(type === "stdio" ? "terminal" : "globe", 14));
}

function transportWord(type: "stdio" | "http"): string {
  return type === "stdio" ? "Local process (stdio)" : "Remote server (HTTP)";
}

// ---------------------------------------------------------------------------
// Manage view
// ---------------------------------------------------------------------------

export function renderMcpHubView(controller: McpHubController): HTMLElement {
  const snapshot = controller.getSnapshot();
  if (snapshot.status !== "ready") {
    const text = snapshot.status === "loading"
      ? "Loading encrypted MCP servers…"
      : (snapshot.statusDetail ?? "Encrypted storage is unavailable.");
    return h("div", { class: "token-hub-body is-status" }, h("div", { class: "th-empty-row" }, text));
  }
  if (!snapshot.servers.length) {
    return h("div", { class: "token-hub-body is-status" },
      h("div", { class: "th-empty-row" }, "No MCP servers yet. Add one to manage stdio commands and HTTP endpoints."));
  }
  const selected = snapshot.servers.find((server) => server.id === snapshot.selectedServerId)
    ?? snapshot.servers[0]
    ?? null;
  const orderStatus = h("div", { class: "th-order-status", role: "status", "aria-live": "polite" });
  const body = h("div", { class: "token-hub-body" },
    h("aside", { class: "th-rail" }, serverList(snapshot, controller, orderStatus), orderStatus),
    selected
      ? serverDetail(selected, controller)
      : h("div", { class: "th-detail th-empty-detail" },
          h("div", { class: "th-empty-row" }, "Select an MCP server.")),
  );
  return body;
}

export function captureMcpHubViewPosition(container: HTMLElement): () => void {
  // Two hubs share .th-provider-list on the Manage page — scope to this card.
  const list = container.querySelector<HTMLElement>(".mcp-hub-card .th-provider-list");
  const detail = container.querySelector<HTMLElement>(".mcp-hub-card .th-detail");
  const railScroll = list?.scrollTop ?? 0;
  const detailScroll = detail?.scrollTop ?? 0;
  const active = document.activeElement as HTMLElement | null;
  const restoreFocus = active && container.contains(active);
  return () => {
    if (list) list.scrollTop = railScroll;
    if (detail) detail.scrollTop = detailScroll;
    if (restoreFocus && active?.isConnected) active.focus({ preventScroll: true });
  };
}

export function syncMcpHubServerOrder(container: HTMLElement, controller: McpHubController): void {
  const list = container.querySelector<HTMLElement>(".mcp-hub-card .th-provider-list");
  if (!list) return;
  syncProviderRows(list, controller.getSnapshot().servers.map((server) => server.id));
}

/**
 * Rebuild ONLY the Manage page's MCP Hub card, in place. A snapshot change
 * used to re-render the whole manage body — which recreates .manage-body
 * (the page scroller) and yanks the page to the top on every edit. The
 * card swap keeps the scroller and every other card's DOM untouched; the
 * rail list's inner scroll is re-applied onto the fresh node. False → no
 * card mounted (caller falls back to a full render).
 */
export function repaintMcpHubCard(
  container: HTMLElement,
  buildCard: () => HTMLElement,
): boolean {
  const card = container.querySelector<HTMLElement>(".mcp-hub-card");
  if (!card) return false;
  const list = card.querySelector<HTMLElement>(".th-provider-list");
  const railScroll = list?.scrollTop ?? 0;
  const fresh = buildCard();
  card.replaceWith(fresh);
  const freshList = fresh.querySelector<HTMLElement>(".th-provider-list");
  if (freshList) freshList.scrollTop = railScroll;
  return true;
}

/**
 * Rebuild ONLY the device detail's MCP card, in place — the .dev-detail
 * column (the scroller) and every sibling card keep their DOM and scroll.
 * The focused server row / action is carried across the swap (keyboard
 * parity with renderDevicesView's providerFocus restore). False → no card
 * mounted (caller decides; e.g. a full render to mount it).
 */
export function repaintDeviceMcpCard(
  container: HTMLElement,
  buildCard: () => HTMLElement,
): boolean {
  const card = container.querySelector<HTMLElement>(".th-device-card.mcp-device-card");
  if (!card) return false;
  const focused = document.activeElement as HTMLElement | null;
  const row = focused?.closest<HTMLElement>(".th-device-profile-row");
  const providerId = row?.dataset.providerId ?? null;
  const action = focused?.dataset.providerAction ?? null;
  const fresh = buildCard();
  card.replaceWith(fresh);
  if (!providerId) return true;
  const next = fresh.querySelector<HTMLElement>(
    `.th-device-profile-row[data-provider-id="${providerId}"]`,
  );
  if (!next) return true; // server gone (deleted / pulled away) — no stale focus
  const button = action
    ? next.querySelector<HTMLButtonElement>(`[data-provider-action="${action}"]:not(:disabled)`)
    : null;
  (button ?? next).focus({ preventScroll: true });
  return true;
}

function serverList(snapshot: McpHubSnapshot, controller: McpHubController, orderStatus: HTMLElement): HTMLElement {
  const list = h("ul", { class: "th-provider-list", role: "listbox", "aria-label": "MCP servers" });
  for (const server of snapshot.servers) {
    const selected = server.id === snapshot.selectedServerId;
    const row = h("li", {
      class: "th-provider-row",
      role: "option",
      "aria-selected": String(selected),
      "data-provider-id": server.id,
      tabindex: "0",
      title: "Drag the grip to reorder · Alt+↑ / Alt+↓",
    },
      h("span", { class: "th-provider-grip", "aria-hidden": "true" }, icon("gripVertical", 13)),
      transportIcon(server.transport.type),
      h("span", { class: "th-provider-copy" },
        h("span", { class: `th-provider-name${server.enabled ? "" : " mcp-off-row"}`, title: server.name }, server.name),
        h("span", { class: "th-provider-meta", title: mcpRailMeta(server) }, mcpRailMeta(server))),
      server.enabled ? statusChip("On", "ok") : statusChip("Off", "muted"));
    row.addEventListener("click", () => controller.selectServer(server.id));
    list.append(row);
  }
  bindRowReorder(list, orderStatus, {
    getIds: () => controller.getSnapshot().servers.map((server) => server.id),
    isSaving: () => controller.isServerOrderSaving(),
    reorder: (ids) => controller.reorderServers(ids),
  });
  return list;
}

function mcpRailMeta(server: McpHubServer): string {
  if (server.transport.type === "stdio") {
    const args = server.transport.args?.length ? ` +${server.transport.args.length}` : "";
    return `${server.transport.command}${args}`;
  }
  return server.transport.url;
}

type KvEntry = { key: string; value: string; revealed: boolean };

/** env/headers row editor: values never echo stored secrets — blank keeps. */
function kvEditor(
  label: string,
  secretKeys: string[],
  onChange: () => void,
): { target: HTMLElement; read: () => Record<string, string> } {
  const target = h("div", { class: "mcp-kv-editor" });
  const wrap = h("div", { class: "mcp-kv-rows" });
  const entries: KvEntry[] = [];
  for (const key of secretKeys) entries.push({ key, value: "", revealed: false });
  if (!secretKeys.length) entries.push({ key: "", value: "", revealed: false });

  const syncInput = (input: HTMLInputElement, entry: KvEntry) => {
    entry.value = input.value;
    onChange();
  };
  const renderRows = () => {
    wrap.replaceChildren();
    entries.forEach((entry, index) => {
      const keyInput = h("input", { class: "th-input", type: "text", placeholder: "KEY", value: entry.key, "aria-label": `${label} key`, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
      keyInput.addEventListener("input", () => { entry.key = keyInput.value.trim(); onChange(); });
      const valueInput = h("input", {
        class: "th-input", type: entry.revealed ? "text" : "password",
        placeholder: entry.key && secretKeys.includes(entry.key) ? "•••••• (leave blank to keep)" : "value",
        value: entry.value, "aria-label": `${label} value`, autocomplete: "off", spellcheck: "false",
      }) as HTMLInputElement;
      valueInput.addEventListener("input", () => syncInput(valueInput, entry));
      const toggle = h("button", {
        class: "th-icon-btn", type: "button",
        "aria-label": entry.revealed ? `Hide ${label} value` : `Show ${label} value`,
        onclick: () => { entry.revealed = !entry.revealed; renderRows(); },
      }, icon(entry.revealed ? "eyeOff" : "eye", 13));
      const remove = h("button", {
        class: "th-icon-btn th-device-delete", type: "button", "aria-label": `Remove ${label} entry`,
        onclick: () => { entries.splice(index, 1); if (!entries.length) entries.push({ key: "", value: "", revealed: false }); renderRows(); onChange(); },
      }, icon("x", 13));
      wrap.append(h("div", { class: "mcp-kv-row" },
        h("label", { class: "mcp-kv-field" }, h("span", { class: "mcp-kv-label" }, "Key"), keyInput),
        h("label", { class: "mcp-kv-field" }, h("span", { class: "mcp-kv-label" }, "Value"), valueInput),
        toggle, remove));
    });
  };
  renderRows();
  target.append(wrap, h("button", {
    class: "th-link-btn", type: "button",
    onclick: () => { entries.push({ key: "", value: "", revealed: true }); renderRows(); onChange(); },
  }, icon("plus", 13), `Add ${label.toLowerCase()}`));
  return {
    target,
    read: () => {
      const out: Record<string, string> = {};
      for (const entry of entries) {
        const key = entry.key.trim();
        if (!key) continue;
        out[key] = entry.value;
      }
      return out;
    },
  };
}

function serverDetail(server: McpHubServer, controller: McpHubController): HTMLElement {
  const detail = h("div", { class: "th-detail" });
  let draft: {
    name: string;
    enabled: boolean;
    transport: McpTransportDraft;
  } | null = null;

  const paint = () => {
    const snapshot = controller.getSnapshot();
    const current = snapshot.servers.find((item) => item.id === server.id) ?? server;
    draft = {
      name: current.name,
      enabled: current.enabled,
      transport: current.transport.type === "stdio"
        ? { type: "stdio", command: current.transport.command, ...(current.transport.args ? { args: [...current.transport.args] } : {}), ...(current.transport.cwd ? { cwd: current.transport.cwd } : {}) }
        : { type: "http", url: current.transport.url },
    };
    const state = h("span", { class: "th-detail-save-state", role: "status", "aria-live": "polite" }, "No changes");
    const nameInput = h("input", {
      class: "th-input th-name-input", type: "text", value: current.name, "aria-label": "Server name", maxlength: "80",
      autocomplete: "off", spellcheck: "false",
    }) as HTMLInputElement;
    const typeSelect = h("select", { class: "th-input th-mode-select", "aria-label": "Transport type" },
      h("option", { value: "stdio" }, "Local process (stdio)"),
      h("option", { value: "http" }, "Remote server (HTTP)")) as HTMLSelectElement;
    typeSelect.value = current.transport.type;
    const enabledSwitch = switchControl(current.enabled, "Server enabled", (checked) => {
      if (!draft) return;
      draft.enabled = checked;
      sync();
    });
    let commandInput: HTMLInputElement | null = null;
    let argsInput: HTMLTextAreaElement | null = null;
    let urlInput: HTMLInputElement | null = null;
    let envEditor: ReturnType<typeof kvEditor> | null = null;
    let headerEditor: ReturnType<typeof kvEditor> | null = null;

    // Transport-specific fields swap inside their own section while the
    // name/transport/enabled section stays mounted.
    const transportSection = h("section", { class: "th-detail-section", "aria-label": transportWord(current.transport.type) });
    const secretsSection = h("section", { class: "th-detail-section", "aria-label": "Secrets" });
    const paintTransport = () => {
      transportSection.replaceChildren();
      secretsSection.replaceChildren();
      envEditor = null;
      headerEditor = null;
      if (draft!.transport.type === "stdio") {
        const t = draft!.transport as Extract<McpTransportDraft, { type: "stdio" }>;
        commandInput = h("input", { class: "th-input", type: "text", value: t.command, "aria-label": "Command", placeholder: "npx", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
        argsInput = h("textarea", { class: "th-input mcp-args-input", rows: "2", "aria-label": "Arguments (one per line)", placeholder: "-y\n@modelcontextprotocol/server-filesystem\n/tmp" }) as HTMLTextAreaElement;
        argsInput.value = (t.args ?? []).join("\n");
        commandInput.addEventListener("input", () => { t.command = commandInput!.value; sync(); });
        argsInput.addEventListener("input", () => {
          t.args = argsInput!.value.split("\n").map((line) => line.trim()).filter(Boolean);
          sync();
        });
        transportSection.append(
          h("h3", { class: "th-detail-section-title" }, "Local process (stdio)"),
          h("div", { class: "th-detail-fields" },
            h("label", { class: "th-detail-field" }, h("span", { class: "th-detail-label" }, "Command"), commandInput),
            h("label", { class: "th-detail-field" },
              h("span", { class: "th-detail-label" }, "Arguments (one per line)"), argsInput,
              h("span", { class: "th-field-hint" }, "Each line becomes one argv entry."))));
        envEditor = kvEditor("Environment variable", current.transport.type === "stdio" ? current.transport.envKeys ?? [] : [], sync);
        secretsSection.append(
          h("h3", { class: "th-detail-section-title" }, "Environment variables"),
          envEditor.target,
          h("span", { class: "th-field-hint" }, "Values never echo back — leave blank to keep a stored one."));
      } else {
        const t = draft!.transport as Extract<McpTransportDraft, { type: "http" }>;
        urlInput = h("input", { class: "th-input", type: "text", value: t.url, "aria-label": "Server URL", placeholder: "https://mcp.example.com/mcp", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
        urlInput.addEventListener("input", () => { t.url = urlInput!.value; sync(); });
        transportSection.append(
          h("h3", { class: "th-detail-section-title" }, "Remote server (HTTP)"),
          h("div", { class: "th-detail-fields" },
            h("label", { class: "th-detail-field" },
              h("span", { class: "th-detail-label" }, "Server URL"), urlInput,
              h("span", { class: "th-field-hint" }, "Streamable HTTP endpoint."))));
        headerEditor = kvEditor("Header", current.transport.type === "http" ? current.transport.headerKeys ?? [] : [], sync);
        secretsSection.append(
          h("h3", { class: "th-detail-section-title" }, "Headers"),
          headerEditor.target,
          h("span", { class: "th-field-hint" }, "Values never echo back — leave blank to keep a stored one."));
      }
      transportSection.setAttribute("aria-label", transportWord(draft!.transport.type));
      secretsSection.setAttribute("aria-label", draft!.transport.type === "stdio" ? "Environment variables" : "Headers");
    };

    nameInput.addEventListener("input", () => {
      if (!draft) return;
      draft.name = nameInput.value;
      sync();
    });
    typeSelect.addEventListener("change", () => {
      if (!draft) return;
      draft.transport = typeSelect.value === "stdio"
        ? { type: "stdio", command: "" }
        : { type: "http", url: "" };
      paintTransport();
      sync();
    });

    const save = h("button", { class: "ghost-btn th-detail-save action-primary", type: "button", disabled: true }, "Save changes");
    const cancel = h("button", { class: "ghost-btn th-detail-cancel", type: "button", hidden: true }, "Cancel");
    const removeBtn = h("button", { class: "ghost-btn th-detail-delete action-danger", type: "button" }, icon("trash2", 13), "Delete");

    const readDraft = (): { name: string; enabled: boolean; transport: McpTransportDraft } => {
      const transport = draft!.transport;
      if (transport.type === "stdio" && envEditor) {
        const env = envEditor.read();
        if (Object.keys(env).length > 0) transport.env = env;
        else delete transport.env;
      }
      if (transport.type === "http" && headerEditor) {
        const headers = headerEditor.read();
        if (Object.keys(headers).length > 0) transport.headers = headers;
        else delete transport.headers;
      }
      return { name: draft!.name, enabled: draft!.enabled, transport };
    };
    const dirty = (): boolean => {
      const next = readDraft();
      return next.name.trim() !== current.name
        || next.enabled !== current.enabled
        || transportChanged(next.transport, current);
    };
    const sync = () => {
      const isDirty = dirty();
      save.disabled = !isDirty;
      cancel.hidden = !isDirty;
      // An enabled flip would push a half-saved config — lock it like the
      // Token Hub locks its name input while a draft is dirty.
      (enabledSwitch.querySelector("input") as HTMLInputElement).disabled = isDirty;
      state.textContent = isDirty ? "Unsaved changes" : "No changes";
    };

    save.addEventListener("click", () => {
      const next = readDraft();
      save.disabled = true;
      state.textContent = "Saving…";
      void controller.updateServer(server.id, next)
        .then(() => {})
        .catch((err: unknown) => {
          state.textContent = "Unsaved changes";
          reportFailure(err);
        });
    });
    cancel.addEventListener("click", () => paint());
    removeBtn.addEventListener("click", () => confirmDeleteServer(server, controller));

    detail.replaceChildren(
      h("div", { class: "th-detail-main" },
        h("section", { class: "th-detail-section", "aria-label": "Server" },
          h("h3", { class: "th-detail-section-title" }, "Server"),
          h("div", { class: "th-detail-fields" },
            h("label", { class: "th-detail-field" }, h("span", { class: "th-detail-label" }, "Name"), nameInput),
            h("label", { class: "th-detail-field" }, h("span", { class: "th-detail-label" }, "Transport"), typeSelect),
            h("div", { class: "th-detail-capability-row" },
              h("div", {},
                h("div", { class: "th-field-label" }, "Enabled"),
                h("div", { class: "th-field-hint" }, "Pushing a server carries this switch to the device.")),
              enabledSwitch))),
        transportSection,
        secretsSection),
      h("div", { class: "th-detail-actions" }, removeBtn, state, cancel, save),
    );
    paintTransport();
    sync();
  };

  const unsubscribe = controller.subscribe((change) => {
    if (change === "server-order") return;
    if (!controller.getSnapshot().servers.some((item) => item.id === server.id)) {
      unsubscribe();
      return;
    }
    paint();
  });
  paint();
  return detail;
}

function transportChanged(next: McpTransportDraft, current: McpHubServer): boolean {
  const cur = current.transport;
  if (next.type !== cur.type) return true;
  if (next.type === "stdio") {
    const c = cur as Extract<typeof cur, { type: "stdio" }>;
    return next.command.trim() !== c.command
      || JSON.stringify(next.args ?? []) !== JSON.stringify(c.args ?? [])
      || (next.env !== undefined);
  }
  const c = cur as Extract<typeof cur, { type: "http" }>;
  return next.url.trim() !== c.url || (next.headers !== undefined);
}

function confirmDeleteServer(server: McpHubServer, controller: McpHubController): void {
  const overlay = h("div", { class: "th-overlay" });
  const dialog = h("div", { class: "th-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Delete MCP server" });
  const close = () => { overlay.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
  const cancel = h("button", { class: "ghost-btn", type: "button", onclick: close }, "Cancel");
  const submit = h("button", {
    class: "ghost-btn action-danger", type: "button",
    onclick: () => { close(); void controller.removeServer(server.id).catch(reportFailure); },
  }, "Delete");
  dialog.append(
    h("h2", { class: "th-dialog-title" }, "Delete MCP server?"),
    h("p", { class: "th-confirm-copy" },
      `Remove “${server.name}” from the Relay? Devices that already received it keep their local copy and will not be updated.`),
    h("div", { class: "th-dialog-actions" }, cancel, submit));
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  window.addEventListener("keydown", onKey, true);
  document.body.append(overlay);
  submit.focus();
}

// ---------------------------------------------------------------------------
// Add server dialog (single step)
// ---------------------------------------------------------------------------

export function openAddServerDialog(controller: McpHubController): void {
  const overlay = h("div", { class: "th-overlay" });
  const dialog = h("div", {
    class: "th-dialog", role: "dialog", "aria-modal": "true", "aria-label": "Add MCP server",
  });
  const finish = () => { overlay.remove(); window.removeEventListener("keydown", onKey, true); };
  const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") finish(); };
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) finish(); });
  window.addEventListener("keydown", onKey, true);

  const nameInput = h("input", { class: "th-input", type: "text", "aria-label": "Server name", placeholder: "filesystem", maxlength: "80", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const typeSelect = h("select", { class: "th-input th-mode-select", "aria-label": "Transport type" },
    h("option", { value: "stdio" }, "Local process (stdio)"),
    h("option", { value: "http" }, "Remote server (HTTP)")) as HTMLSelectElement;
  const enabledSwitch = switchControl(true, "Server enabled", (checked) => { draft.enabled = checked; });
  const commandInput = h("input", { class: "th-input", type: "text", "aria-label": "Command", placeholder: "npx", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const argsInput = h("textarea", { class: "th-input mcp-args-input", rows: "2", "aria-label": "Arguments (one per line)", placeholder: "-y\n@modelcontextprotocol/server-filesystem\n/tmp" }) as HTMLTextAreaElement;
  const urlInput = h("input", { class: "th-input", type: "text", "aria-label": "Server URL", placeholder: "https://mcp.example.com/mcp", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
  const errorRow = h("div", { class: "th-inline-error", role: "alert", hidden: true }, icon("warn", 13), h("span", {}));
  const draft: { name: string; enabled: boolean; type: "stdio" | "http" } = { name: "", enabled: true, type: "stdio" };
  nameInput.addEventListener("input", () => { draft.name = nameInput.value; });
  typeSelect.addEventListener("change", () => { draft.type = typeSelect.value as "stdio" | "http"; paintType(); });

  let envEditor = kvEditor("Environment variable", [], () => {});
  let headerEditor = kvEditor("Header", [], () => {});
  const stdioSection = h("div", { class: "mcp-transport-sections" });
  const httpSection = h("div", { class: "mcp-transport-sections" });
  const paintType = () => {
    const stdio = draft.type === "stdio";
    stdioSection.hidden = !stdio;
    httpSection.hidden = stdio;
    if (stdio && !stdioSection.childElementCount) {
      envEditor = kvEditor("Environment variable", [], () => {});
      stdioSection.append(
        h("div", { class: "th-field" }, h("span", { class: "th-field-label" }, "Command"), commandInput),
        h("div", { class: "th-field" },
          h("span", { class: "th-field-label" }, "Arguments (one per line)"), argsInput,
          h("span", { class: "th-field-hint" }, "Each line becomes one argv entry.")),
        h("div", { class: "th-detail-section-title" }, "Environment variables"),
        envEditor.target);
    }
    if (!stdio && !httpSection.childElementCount) {
      headerEditor = kvEditor("Header", [], () => {});
      httpSection.append(
        h("div", { class: "th-field" },
          h("span", { class: "th-field-label" }, "Server URL"), urlInput,
          h("span", { class: "th-field-hint" }, "Streamable HTTP endpoint.")),
        h("div", { class: "th-detail-section-title" }, "Headers"),
        headerEditor.target);
    }
  };

  const submit = h("button", { class: "ghost-btn action-primary", type: "button" }, "Add server");
  const cancel = h("button", { class: "ghost-btn", type: "button", onclick: finish }, "Cancel");
  const show = (message: string) => {
    errorRow.hidden = false;
    (errorRow.lastChild as HTMLElement).textContent = message;
  };
  submit.addEventListener("click", () => {
    const name = draft.name.trim();
    if (!name) { show("Server name is required."); nameInput.focus(); return; }
    if (controller.getSnapshot().servers.some((server) => server.name.trim().toLowerCase() === name.toLowerCase())) {
      show("A server with this name already exists.");
      nameInput.focus();
      return;
    }
    let transport: McpTransportDraft;
    if (draft.type === "stdio") {
      const command = commandInput.value.trim();
      if (!command) { show("stdio command is required."); commandInput.focus(); return; }
      const args = argsInput.value.split("\n").map((line) => line.trim()).filter(Boolean);
      const env = envEditor.read();
      transport = { type: "stdio", command, ...(args.length ? { args } : {}), ...(Object.keys(env).length ? { env } : {}) };
    } else {
      const url = urlInput.value.trim();
      try { void new URL(url); } catch { show("A valid MCP URL is required."); urlInput.focus(); return; }
      const headers = headerEditor.read();
      transport = { type: "http", url, ...(Object.keys(headers).length ? { headers } : {}) };
    }
    submit.disabled = true;
    void controller.addServer({ name, enabled: draft.enabled, transport })
      .then(finish)
      .catch((err: unknown) => {
        submit.disabled = false;
        show(err instanceof Error ? err.message : String(err));
      });
  });

  dialog.append(
    h("div", { class: "th-dialog-head" },
      h("h2", { class: "th-dialog-title" }, "Add MCP Server"),
      h("button", { class: "th-icon-btn", type: "button", "aria-label": "Close", onclick: finish }, icon("x", 14))),
    h("div", { class: "th-dialog-page" },
      h("div", { class: "th-field" },
        h("span", { class: "th-field-label" }, "Name"), nameInput,
        h("span", { class: "th-field-hint" }, "Devices match servers by name.")),
      h("div", { class: "th-field" }, h("span", { class: "th-field-label" }, "Transport"), typeSelect),
      h("div", { class: "th-field" },
        h("span", { class: "th-field-label" }, "Enabled"), enabledSwitch,
        h("span", { class: "th-field-hint" }, "Pushing a server carries this switch to the device.")),
      stdioSection, httpSection, errorRow),
    h("div", { class: "th-dialog-actions" }, cancel, submit));
  overlay.append(dialog);
  document.body.append(overlay);
  nameInput.focus();
}

// ---------------------------------------------------------------------------
// Devices view
// ---------------------------------------------------------------------------

function deviceMcpMeta(server: DeviceSyncMcpServer): HTMLElement {
  const text = server.transport.type === "stdio"
    ? `${server.transport.command}${server.transport.args?.length ? ` +${server.transport.args.length} arg${server.transport.args.length === 1 ? "" : "s"}` : ""}`
    : server.transport.url;
  return h("span", { class: "th-profile-copy" },
    h("span", { class: "th-profile-name", title: server.name }, server.name),
    h("span", { class: "th-profile-meta", title: text }, text));
}

function deviceRuntimeChip(server: DeviceSyncMcpServer): HTMLElement {
  if (!server.enabled) return h("span", { class: "th-status is-muted mcp-runtime-chip" }, "Off");
  switch (server.status) {
    case "connected":
      return h("span", {
        class: "th-status is-ok mcp-runtime-chip",
        title: `${server.toolCount ?? 0} tools available`,
      }, `${server.toolCount ?? 0} tools`);
    case "connecting":
      return h("span", { class: "th-status is-warn mcp-runtime-chip", title: "Connecting…" }, "connecting");
    case "error":
      return h("span", {
        class: "th-status is-warn mcp-runtime-chip",
        title: server.errorMessage ?? "Connection failed",
      }, "Error");
    default:
      return h("span", { class: "th-status is-muted mcp-runtime-chip", title: "Not connected" }, "idle");
  }
}

function mcpDeviceDialog(title: string, subtitle: string): {
  dialog: HTMLElement; body: HTMLElement; footer: HTMLElement; close: () => void; onClose: (fn: () => void) => void;
} {
  const previousFocus = document.activeElement as HTMLElement | null;
  const overlay = h("div", { class: "th-overlay th-device-overlay" });
  const dialog = h("div", { class: "th-dialog th-device-dialog", role: "dialog", "aria-modal": "true", "aria-label": title });
  const body = h("div", { class: "th-device-dialog-body" });
  const footer = h("div", { class: "th-device-dialog-footer" });
  let cleanup = () => {};
  const close = () => {
    cleanup();
    overlay.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
    else document.querySelector<HTMLButtonElement>(".th-device-add")?.focus();
  };
  const closeButton = h("button", { class: "th-icon-btn", type: "button", "aria-label": "Close", onclick: close }, icon("x", 14));
  dialog.append(h("div", { class: "th-dialog-head" },
    h("div", {}, h("h2", { class: "th-dialog-title" }, title), h("div", { class: "th-dialog-sub" }, subtitle)),
    closeButton), body, footer);
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (event) => { if (event.target === overlay) close(); });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key !== "Tab") return;
    const buttons = [...dialog.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  document.body.append(overlay);
  closeButton.focus();
  return { dialog, body, footer, close, onClose: (fn) => { cleanup = fn; } };
}

function confirmDeviceMcp(opts: {
  title: string; serverName: string; message: string; action: string; danger?: boolean; onConfirm: () => Promise<unknown>;
}): void {
  const modal = mcpDeviceDialog(opts.title, opts.serverName);
  modal.dialog.classList.add("th-device-confirm");
  modal.body.append(h("p", { class: "th-device-confirm-copy" }, opts.message));
  const cancel = h("button", { class: "ghost-btn", type: "button", onclick: modal.close }, "Cancel");
  const submit = h("button", {
    class: `ghost-btn th-device-confirm-submit ${opts.danger ? "is-danger action-danger" : "action-primary"}`,
    type: "button",
    onclick: () => { modal.close(); void opts.onConfirm().catch(() => {}); },
  }, opts.action);
  modal.footer.append(cancel, submit);
  cancel.focus();
}

function openMcpDeviceHubDialog(deviceId: string, deviceName: string, controller: McpHubController): void {
  const modal = mcpDeviceDialog("Add from Hub", `To ${deviceName}`);
  const done = h("button", { class: "ghost-btn", type: "button", onclick: modal.close }, "Done");
  modal.footer.append(done);
  const render = () => {
    const activeId = (document.activeElement as HTMLElement | null)?.dataset.hubProviderId;
    const preview = controller.getDeviceSyncPreview(deviceId);
    const pending = controller.getSyncPending(deviceId);
    const error = controller.getSyncError(deviceId);
    const busy = pending !== null;
    modal.body.replaceChildren();
    if (!preview || pending === "preview") {
      modal.body.append(h("div", { class: "th-empty-row", role: "status" }, pending === "preview" ? "Loading Hub servers…" : error ?? "Loading servers…"));
      if (error && !busy) modal.body.append(h("button", {
        class: "th-link-btn th-device-retry", type: "button",
        onclick: () => { void controller.loadDeviceSyncPreview(deviceId).catch(() => {}); },
      }, "Retry"));
      return;
    }
    if (error) modal.body.append(h("div", { class: "th-inline-error", role: "alert" }, icon("warn", 13), h("span", {}, error)));
    if (!preview.deviceOnline || !preview.supportsSync) {
      modal.body.append(h("div", { class: "th-empty-row" }, preview.deviceOnline
        ? "Update this device to manage MCP servers remotely."
        : "Device offline — adding servers is unavailable."));
      return;
    }
    const rows = h("ul", { class: "th-device-hub-list", "aria-label": "Hub MCP Servers" });
    for (const server of preview.hubServers) {
      const operation = controller.getDeviceOperation(deviceId, "push", server.id);
      const replacing = server.match === "overwrite";
      const label = operation?.status === "pending" ? (replacing ? "Replacing…" : "Adding…")
        : operation?.status === "done" ? (operation.action === "overwrite" ? "Replaced" : "Added")
        : operation?.status === "failed" ? "Failed · Retry" : replacing ? "Replace" : "Add";
      const action = h("button", {
        class: `th-device-hub-action action-primary${operation?.status === "done" ? " is-done" : operation?.status === "failed" ? " is-error" : ""}`,
        type: "button", "data-hub-provider-id": server.id, "aria-label": `${label}: ${server.name}`,
        disabled: busy || operation?.status === "done",
        "aria-busy": String(operation?.status === "pending"),
        onclick: () => { void controller.pushServerToDevice(deviceId, server.id).catch(() => {}); },
      }, operation?.status === "pending" ? h("span", { class: "spinner th-button-spinner", "aria-hidden": "true" })
        : operation?.status === "done" ? icon("check", 13) : operation?.status === "failed" ? icon("refresh", 13) : null,
      label);
      rows.append(h("li", { class: "th-device-hub-row" }, transportIcon(server.transport.type), mcpHubServerCopy(server), action));
    }
    if (!preview.hubServers.length) rows.append(h("li", { class: "th-empty-row" }, "No MCP servers in the Hub yet."));
    modal.body.append(rows);
    if (activeId) {
      const button = [...rows.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.dataset.hubProviderId === activeId);
      if (button && !button.disabled) button.focus(); else done.focus();
    }
  };
  modal.onClose(controller.subscribe(render));
  render();
  void controller.loadDeviceSyncPreview(deviceId).catch(() => {});
}

function mcpHubServerCopy(server: { name: string; transport: McpHubServer["transport"] }): HTMLElement {
  const text = server.transport.type === "stdio"
    ? `${server.transport.command}${server.transport.args?.length ? ` +${server.transport.args.length} arg${server.transport.args.length === 1 ? "" : "s"}` : ""}`
    : server.transport.url;
  return h("span", { class: "th-profile-copy" },
    h("span", { class: "th-profile-name", title: server.name }, server.name),
    h("span", { class: "th-profile-meta", title: text }, text));
}

export function buildDeviceMcpCard(
  deviceId: string, deviceName: string, online: boolean, controller: McpHubController,
): HTMLElement {
  const snapshot = controller.getSnapshot();
  const preview = controller.getDeviceSyncPreview(deviceId);
  const pending = controller.getSyncPending(deviceId);
  const error = controller.getSyncError(deviceId);
  const servers = preview?.deviceServers ?? [];
  const busy = pending !== null;
  const available = online && preview?.deviceOnline && preview.supportsSync && snapshot.status === "ready";
  const status = !online ? (servers.length ? "Offline · showing last loaded servers" : "Device offline")
    : pending === "preview" ? "Loading device MCP servers…"
    : !preview ? (error ? "Could not load device MCP servers" : "Loading device MCP servers…")
    : !preview.supportsSync ? "Update this device to manage MCP servers remotely."
    : `${servers.length} server${servers.length === 1 ? "" : "s"} on this device`;
  const rows = h("ul", { class: "th-device-profiles", "aria-label": `MCP servers on ${deviceName}` });
  for (const server of servers) {
    const copying = controller.getDeviceOperation(deviceId, "pull", server.id);
    const removing = controller.getDeviceOperation(deviceId, "remove", server.id);
    const label = copying?.status === "pending" ? "Copying…" : copying?.status === "done" ? "Copied"
      : copying?.status === "failed" ? "Failed · Retry" : "Copy to Relay";
    const copyButton = h("button", {
      class: `ghost-btn th-device-copy${copying?.status === "done" ? " is-done" : copying?.status === "failed" ? " is-error" : ""}`,
      type: "button", "data-provider-action": "copy", "aria-label": `${label}: ${server.name}`,
      disabled: !available || busy || copying?.status === "done",
      "aria-busy": String(copying?.status === "pending"),
      onclick: () => {
        if (server.match === "overwrite") confirmDeviceMcp({
          title: "Replace server in Relay?", serverName: server.name, action: "Replace",
          message: `A server with this name already exists in the Hub. Replace it with the copy from ${deviceName}?`,
          onConfirm: () => controller.pullServerFromDevice(deviceId, server.id),
        });
        else void controller.pullServerFromDevice(deviceId, server.id).catch(() => {});
      },
    }, copying?.status === "pending" ? h("span", { class: "spinner th-button-spinner", "aria-hidden": "true" })
      : icon(copying?.status === "done" ? "check" : copying?.status === "failed" ? "refresh" : "copy", 13), label);
    const removeButton = h("button", {
      class: "th-icon-btn th-device-delete action-danger action-danger-list", type: "button", "data-provider-action": "delete",
      "aria-busy": String(removing?.status === "pending"),
      "aria-label": `Delete ${server.name} from ${deviceName}`,
      title: removing?.error ?? "Delete from this device",
      disabled: !available || busy,
      onclick: () => confirmDeviceMcp({
        title: "Delete MCP server?", serverName: server.name, action: "Delete", danger: true,
        message: `Remove this MCP server from ${deviceName}? Its tools become unavailable on this device.`,
        onConfirm: () => controller.removeServerFromDevice(deviceId, server.id),
      }),
    }, removing?.status === "pending" ? h("span", { class: "spinner th-button-spinner", "aria-hidden": "true" })
      : icon(removing?.status === "failed" ? "refresh" : "trash2", 13));
    rows.append(h("li", { class: "th-device-profile-row", "data-provider-id": server.id },
      transportIcon(server.transport.type),
      h("span", { class: "th-profile-copy" },
        h("span", { class: "th-profile-name", title: server.name }, server.name),
        h("span", { class: "th-profile-meta", title: server.transport.type === "stdio" ? server.transport.command : server.transport.url },
          server.transport.type === "stdio" ? server.transport.command : server.transport.url),
        deviceRuntimeChip(server)),
      h("div", { class: "th-device-row-actions" }, copyButton, removeButton)));
  }
  if (!servers.length) rows.append(h("li", { class: "th-empty-row" },
    !online ? "Connect this device to load its MCP servers."
      : preview?.supportsSync ? "This device has no MCP servers." : status));
  const body = h("div", { class: "card-body flush" }, rows,
    h("span", { class: "th-device-live", role: "status", "aria-live": "polite", "aria-atomic": "true" }, controller.getSyncAnnouncement(deviceId)));
  if (error || snapshot.status === "unavailable") {
    body.append(h("div", { class: "th-inline-error th-device-sync-error", role: "alert" }, icon("warn", 13),
      h("span", {}, error ?? snapshot.statusDetail ?? "Encrypted storage is unavailable."),
      ...(online && !busy ? [h("button", { class: "th-link-btn", type: "button", onclick: () => {
        void controller.loadDeviceSyncPreview(deviceId).catch(() => {});
      } }, "Retry")] : [])));
  }
  return h("div", { class: "card th-device-card mcp-device-card", "data-device-id": deviceId },
    h("div", { class: "card-head" },
      h("span", { class: "ic card-header-symbol" }, cardHeaderIcon("mcp")),
      h("div", { class: "th-device-heading" }, h("div", { class: "t" }, "MCP Servers"), h("div", { class: "d", role: "status" }, status)),
      h("div", { class: "card-actions" }, h("button", {
        class: "ghost-btn th-device-add action-primary", type: "button", disabled: !available || busy,
        onclick: () => openMcpDeviceHubDialog(deviceId, deviceName, controller),
      }, icon("plus", 13), "Add from Hub"))), body);
}
