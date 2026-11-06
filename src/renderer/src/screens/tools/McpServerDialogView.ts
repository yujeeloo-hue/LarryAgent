import "./mcp-server-dialog.css";

export type McpServerDialogDraft = {
  id?: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
};

export type McpServerDialogResult = McpServerDialogDraft | null;

/**
 * Modal dialog to add or edit an MCP server (stdio or HTTP).
 */
export function showMcpServerDialog(
  initial?: Partial<McpServerDialogDraft>,
): Promise<McpServerDialogResult> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "mcp-dialog-overlay";
    overlay.setAttribute("role", "presentation");

    const dialog = document.createElement("div");
    dialog.className = "mcp-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "mcp-dialog-title");

    const title = document.createElement("h2");
    title.id = "mcp-dialog-title";
    title.className = "mcp-dialog-title";
    title.textContent = initial?.id ? "Edit MCP server" : "Add MCP server";

    const form = document.createElement("form");
    form.className = "mcp-dialog-form";

    const nameField = fieldBlock("Name");
    const nameInput = document.createElement("input");
    nameInput.className = "mcp-dialog-input";
    nameInput.type = "text";
    nameInput.required = true;
    nameInput.placeholder = "My MCP server";
    nameInput.value = initial?.name ?? "";
    nameField.append(nameInput);

    const transportField = fieldBlock("Transport");
    const transportRow = document.createElement("div");
    transportRow.className = "mcp-dialog-radio-row";
    const stdioRadio = radioOption("transport", "stdio", "stdio", "stdio");
    const httpRadio = radioOption("transport", "http", "http", "HTTP");
    transportRow.append(stdioRadio.label, httpRadio.label);
    transportField.append(transportRow);

    const stdioPanel = document.createElement("div");
    stdioPanel.className = "mcp-dialog-panel";
    const commandField = fieldBlock("Command");
    const commandInput = document.createElement("input");
    commandInput.className = "mcp-dialog-input";
    commandInput.type = "text";
    commandInput.placeholder = "npx";
    commandField.append(commandInput);

    const argsField = fieldBlock("Arguments (one per line)");
    const argsInput = document.createElement("textarea");
    argsInput.className = "mcp-dialog-textarea";
    argsInput.rows = 3;
    argsInput.placeholder = "-y\n@modelcontextprotocol/server-filesystem\n/path";
    argsField.append(argsInput);

    const envField = fieldBlock("Environment (KEY=value, one per line)");
    const envInput = document.createElement("textarea");
    envInput.className = "mcp-dialog-textarea";
    envInput.rows = 3;
    envInput.placeholder = "API_KEY=…";
    envField.append(envInput);

    const cwdField = fieldBlock("Working directory (optional)");
    const cwdInput = document.createElement("input");
    cwdInput.className = "mcp-dialog-input";
    cwdInput.type = "text";
    cwdInput.placeholder = "/absolute/path";
    cwdField.append(cwdInput);
    stdioPanel.append(commandField, argsField, envField, cwdField);

    const httpPanel = document.createElement("div");
    httpPanel.className = "mcp-dialog-panel";
    const urlField = fieldBlock("URL");
    const urlInput = document.createElement("input");
    urlInput.className = "mcp-dialog-input";
    urlInput.type = "url";
    urlInput.placeholder = "https://example.com/mcp";
    urlField.append(urlInput);

    const headersField = fieldBlock("Headers (Key: value, one per line)");
    const headersInput = document.createElement("textarea");
    headersInput.className = "mcp-dialog-textarea";
    headersInput.rows = 3;
    headersInput.placeholder = "Authorization: Bearer …";
    headersField.append(headersInput);
    httpPanel.append(urlField, headersField);

    const enabledField = document.createElement("label");
    enabledField.className = "mcp-dialog-check";
    const enabledInput = document.createElement("input");
    enabledInput.type = "checkbox";
    enabledInput.checked = initial?.enabled !== false;
    const enabledText = document.createElement("span");
    enabledText.textContent = "Enabled (connect after save)";
    enabledField.append(enabledInput, enabledText);

    const errorEl = document.createElement("p");
    errorEl.className = "mcp-dialog-error";
    errorEl.hidden = true;

    const actions = document.createElement("div");
    actions.className = "mcp-dialog-actions";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "mcp-dialog-btn";
    cancelBtn.textContent = "Cancel";
    const saveBtn = document.createElement("button");
    saveBtn.type = "submit";
    saveBtn.className = "mcp-dialog-btn mcp-dialog-btn-confirm action-primary";
    saveBtn.textContent = "Save";
    actions.append(cancelBtn, saveBtn);

    form.append(
      nameField,
      transportField,
      stdioPanel,
      httpPanel,
      enabledField,
      errorEl,
      actions,
    );
    dialog.append(title, form);
    overlay.append(dialog);
    document.body.append(overlay);

    const initialTransport = initial?.transport;
    if (initialTransport?.type === "http") {
      httpRadio.input.checked = true;
      urlInput.value = initialTransport.url;
      headersInput.value = recordToColonLines(initialTransport.headers);
    } else {
      stdioRadio.input.checked = true;
      if (initialTransport?.type === "stdio") {
        commandInput.value = initialTransport.command;
        argsInput.value = (initialTransport.args ?? []).join("\n");
        envInput.value = recordToEnvLines(initialTransport.env);
        cwdInput.value = initialTransport.cwd ?? "";
      }
    }

    function syncPanels(): void {
      const isHttp = httpRadio.input.checked;
      stdioPanel.hidden = isHttp;
      httpPanel.hidden = !isHttp;
      commandInput.required = !isHttp;
      urlInput.required = isHttp;
    }
    syncPanels();
    stdioRadio.input.addEventListener("change", syncPanels);
    httpRadio.input.addEventListener("change", syncPanels);

    const finish = (result: McpServerDialogResult): void => {
      overlay.remove();
      window.removeEventListener("keydown", onKeyDown);
      resolve(result);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);

    cancelBtn.addEventListener("click", () => finish(null));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      errorEl.hidden = true;
      const name = nameInput.value.trim();
      if (!name) {
        showError("Name is required.");
        return;
      }

      try {
        let transport: McpTransport;
        if (httpRadio.input.checked) {
          const url = urlInput.value.trim();
          if (!url) {
            showError("URL is required.");
            return;
          }
          void new URL(url);
          const headers = parseColonLines(headersInput.value);
          transport = {
            type: "http",
            url,
            ...(headers ? { headers } : {}),
          };
        } else {
          const command = commandInput.value.trim();
          if (!command) {
            showError("Command is required.");
            return;
          }
          const args = argsInput.value
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
          const env = parseEnvLines(envInput.value);
          const cwd = cwdInput.value.trim();
          transport = {
            type: "stdio",
            command,
            ...(args.length > 0 ? { args } : {}),
            ...(env ? { env } : {}),
            ...(cwd ? { cwd } : {}),
          };
        }

        const draft: McpServerDialogDraft = {
          name,
          enabled: enabledInput.checked,
          transport,
        };
        if (initial?.id) draft.id = initial.id;
        finish(draft);
      } catch (err) {
        showError(err instanceof Error ? err.message : "Invalid configuration.");
      }
    });

    function showError(message: string): void {
      errorEl.textContent = message;
      errorEl.hidden = false;
    }

    queueMicrotask(() => nameInput.focus());
  });
}

function fieldBlock(labelText: string): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "mcp-dialog-field";
  const label = document.createElement("span");
  label.className = "mcp-dialog-label";
  label.textContent = labelText;
  wrap.append(label);
  return wrap;
}

function radioOption(
  name: string,
  value: string,
  id: string,
  labelText: string,
): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.className = "mcp-dialog-radio";
  const input = document.createElement("input");
  input.type = "radio";
  input.name = name;
  input.value = value;
  input.id = `mcp-transport-${id}`;
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(input, text);
  return { label, input };
}

function parseEnvLines(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!key) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseColonLines(raw: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    if (!key) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function recordToEnvLines(record?: Record<string, string>): string {
  if (!record) return "";
  return Object.entries(record)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

function recordToColonLines(record?: Record<string, string>): string {
  if (!record) return "";
  return Object.entries(record)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}
