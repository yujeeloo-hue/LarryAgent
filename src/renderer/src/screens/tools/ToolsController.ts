import { showMcpServerDialog } from "./McpServerDialogView.js";
import { getMcpToolUiDescription } from "../../../../tools/uiDescriptions.js";
import type {
  ToolsMcpServerRow,
  ToolsMcpToolRow,
  ToolsPermissionLevel,
  ToolsTableGroup,
  ToolsTableRow,
  ToolsView,
} from "./ToolsView.js";

function requireBridge(): NonNullable<Window["jellybot"]> {
  if (!window.jellybot) {
    throw new Error("JellyBot bridge is not available");
  }
  return window.jellybot;
}

/** Tools screen — built-in permissions + MCP server management. */
export class ToolsController {
  private destroyed = false;
  private allGroups: ToolsTableGroup[] = [];
  private mcpServers: McpServerRuntime[] = [];
  private query = "";
  private ncUnsubscribe: (() => void) | null = null;
  private ncReloadTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly view: ToolsView) {
    this.view.setOnPermissionChange((name, level) => {
      void this.onPermissionChange(name, level);
    });
    this.view.setOnOfferChange((name, include) => {
      void this.onOfferChange(name, include);
    });
    this.view.setOnAutoOrganize(() => {
      void this.onAutoOrganize();
    });
    this.view.setOnQueryChange((query) => {
      this.query = query;
      this.renderFiltered();
    });
    this.view.setOnAddMcp(() => {
      void this.onAddMcp();
    });
    this.view.setOnReloadMcp(() => {
      void this.onReloadMcp();
    });
    this.view.setOnEditMcp((id) => {
      void this.onEditMcp(id);
    });
    this.view.setOnRemoveMcp((id) => {
      void this.onRemoveMcp(id);
    });
    this.view.setOnReconnectMcp((id) => {
      void this.onReconnectMcp(id);
    });
    this.view.setOnToggleMcp((id, enabled) => {
      void this.onToggleMcp(id, enabled);
    });
  }

  mount(): HTMLElement {
    void this.reload();
    this.subscribeNotificationEvents();
    return this.view.root;
  }

  destroy(): void {
    this.destroyed = true;
    this.ncUnsubscribe?.();
    this.ncUnsubscribe = null;
    if (this.ncReloadTimer) {
      clearTimeout(this.ncReloadTimer);
      this.ncReloadTimer = undefined;
    }
    this.view.setOnPermissionChange(null);
    this.view.setOnOfferChange(null);
    this.view.setOnAutoOrganize(null);
    this.view.setOnQueryChange(null);
    this.view.setOnAddMcp(null);
    this.view.setOnReloadMcp(null);
    this.view.setOnEditMcp(null);
    this.view.setOnRemoveMcp(null);
    this.view.setOnReconnectMcp(null);
    this.view.setOnToggleMcp(null);
    this.view.root.remove();
  }

  /**
   * Cross-entry refresh: main broadcasts "mcp/server_status" and
   * "tools/config_changed" over the nc:event bridge (e.g. an agent tool or
   * remote sync changed tools.json outside this window). Debounced reload —
   * a connect burst (connecting → connected) coalesces into one re-pull.
   */
  private subscribeNotificationEvents(): void {
    if (this.ncUnsubscribe) return;
    const bridge = typeof window !== "undefined" ? window.jellybot : undefined;
    if (typeof bridge?.onNotificationCenterEvent !== "function") return;
    this.ncUnsubscribe = bridge.onNotificationCenterEvent((payload) => {
      if (this.destroyed) return;
      if (
        payload.eventName !== "mcp/server_status" &&
        payload.eventName !== "tools/config_changed"
      ) {
        return;
      }
      if (this.ncReloadTimer) clearTimeout(this.ncReloadTimer);
      this.ncReloadTimer = setTimeout(() => {
        this.ncReloadTimer = undefined;
        if (!this.destroyed) void this.reload();
      }, 300);
    });
  }

  private async reload(): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const bridge = requireBridge();
      const [groups, mcpServers] = await Promise.all([
        bridge.listTools(),
        bridge.listMcpServers(),
      ]);
      if (this.destroyed) return;
      this.allGroups = toTableGroups(groups);
      this.mcpServers = mcpServers;
      this.renderFiltered();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to load tools.";
      this.view.setStatus(message, "error");
      this.allGroups = [];
      this.mcpServers = [];
      this.view.setMcpServers([]);
      this.view.setGroups([]);
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private renderFiltered(): void {
    const filtered = filterToolGroups(this.allGroups, this.query);
    const trimmed = this.query.trim();
    this.view.setMcpServers(
      filterMcpServers(this.mcpServers, this.query).map(toMcpRow),
    );
    this.view.setGroups(filtered, {
      emptyMessage: trimmed
        ? `No tools match “${trimmed}”.`
        : "No tools registered.",
    });
  }

  private async onPermissionChange(
    name: string,
    level: ToolsPermissionLevel,
  ): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const updated = await requireBridge().setToolPermissionLevel({
        name,
        level,
      });
      if (this.destroyed) return;
      patchToolPermission(this.allGroups, updated);
      patchMcpToolPermission(this.mcpServers, updated);
      this.view.updateToolPermission(
        updated.name,
        updated.permissionLevel,
        updated.defaultPermissionLevel,
      );
      if (typeof updated.offered === "boolean") {
        this.view.updateToolOffer(
          updated.name,
          updated.offered,
          updated.offerLocked,
        );
      }
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to update permission.";
      this.view.setStatus(message, "error");
      await this.reload();
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private async onOfferChange(name: string, include: boolean): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const updated = await requireBridge().setToolOffer({ name, include });
      if (this.destroyed) return;
      patchToolOffer(this.allGroups, updated);
      patchMcpToolOffer(this.mcpServers, updated);
      this.view.updateToolOffer(
        updated.name,
        updated.offered,
        updated.offerLocked,
      );
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to update Include.";
      this.view.setStatus(message, "error");
      await this.reload();
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private async onAutoOrganize(): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const result = await requireBridge().autoOrganizeToolOffers();
      if (this.destroyed) return;
      await this.reload();
      if (this.destroyed) return;
      this.view.setStatus(
        `Auto-organized always-offer tools (${result.baseline.length} selected).`,
        "info",
      );
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to auto-organize tools.";
      this.view.setStatus(message, "error");
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private async onAddMcp(): Promise<void> {
    const draft = await showMcpServerDialog();
    if (!draft || this.destroyed) return;
    await this.persistMcpUpsert(draft);
  }

  private async onReloadMcp(): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const servers = await requireBridge().reloadMcpServers();
      if (this.destroyed) return;
      await this.reload();
      if (this.destroyed) return;
      const connected = servers.filter((s) => s.status === "connected").length;
      const failed = servers.filter((s) => s.status === "error").length;
      const parts = [`${servers.length} server(s), ${connected} connected`];
      if (failed > 0) parts.push(`${failed} error`);
      this.view.setStatus(`MCP reloaded from tools.json — ${parts.join(", ")}.`, "info");
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to reload MCP servers.";
      this.view.setStatus(message, "error");
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private async onEditMcp(id: string): Promise<void> {
    const existing = this.mcpServers.find((s) => s.id === id);
    if (!existing) return;
    const draft = await showMcpServerDialog({
      id: existing.id,
      name: existing.name,
      enabled: existing.enabled,
      transport: existing.transport,
    });
    if (!draft || this.destroyed) return;
    await this.persistMcpUpsert({ ...draft, id });
  }

  private async persistMcpUpsert(draft: {
    id?: string;
    name: string;
    enabled: boolean;
    transport: McpTransport;
  }): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      await requireBridge().upsertMcpServer(draft);
      if (this.destroyed) return;
      await this.reload();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to save MCP server.";
      this.view.setStatus(message, "error");
      this.view.setBusy(false);
    }
  }

  private async onRemoveMcp(id: string): Promise<void> {
    const existing = this.mcpServers.find((s) => s.id === id);
    const name = existing?.name ?? "this MCP server";
    const bridge = requireBridge();
    const ok = await bridge.confirmDialog({
      title: "Remove MCP server",
      message: `Remove “${name}”? Its tools will no longer be available to the model.`,
    });
    if (!ok || this.destroyed) return;

    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      await bridge.removeMcpServer(id);
      if (this.destroyed) return;
      await this.reload();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to remove MCP server.";
      this.view.setStatus(message, "error");
      this.view.setBusy(false);
    }
  }

  private async onReconnectMcp(id: string): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const runtime = await requireBridge().reconnectMcpServer(id);
      if (this.destroyed) return;
      this.patchMcpServer(runtime);
      this.renderFiltered();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to reconnect MCP server.";
      this.view.setStatus(message, "error");
      await this.reload();
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private async onToggleMcp(id: string, enabled: boolean): Promise<void> {
    this.view.setBusy(true);
    this.view.setStatus(null);
    try {
      const runtime = await requireBridge().setMcpServerEnabled({ id, enabled });
      if (this.destroyed) return;
      this.patchMcpServer(runtime);
      this.renderFiltered();
    } catch (err) {
      if (this.destroyed) return;
      const message =
        err instanceof Error ? err.message : "Failed to update MCP server.";
      this.view.setStatus(message, "error");
      await this.reload();
    } finally {
      if (!this.destroyed) this.view.setBusy(false);
    }
  }

  private patchMcpServer(runtime: McpServerRuntime): void {
    const index = this.mcpServers.findIndex((s) => s.id === runtime.id);
    if (index >= 0) {
      this.mcpServers[index] = runtime;
    } else {
      this.mcpServers.push(runtime);
    }
  }
}

function toTableGroups(groups: ToolCatalogGroup[]): ToolsTableGroup[] {
  return groups.map((group) => ({
    categoryId: group.category.id,
    label: group.category.label,
    description: group.category.description,
    tools: group.tools.map((tool) => {
      const row: ToolsTableRow = {
        name: tool.name,
        displayName: tool.displayName,
        description: tool.displayDescription,
        permissionLevel: tool.permissionLevel,
        defaultPermissionLevel: tool.defaultPermissionLevel,
        offered: tool.offered,
        visible: tool.visible !== false,
        callCount: tool.callCount ?? 0,
      };
      if (tool.offerLocked === true) row.offerLocked = true;
      if (tool.displayLocked === true) row.displayLocked = true;
      return row;
    }),
  }));
}

function toMcpRow(server: McpServerRuntime): ToolsMcpServerRow {
  const row: ToolsMcpServerRow = {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transportSummary: summarizeTransport(server.transport),
    status: server.status,
    tools: server.tools.map((tool) => {
      const t: ToolsMcpToolRow = {
        name: tool.name,
        description: getMcpToolUiDescription(tool.name, server.name),
        registryName: tool.registryName,
        permissionLevel: tool.permissionLevel,
        defaultPermissionLevel: tool.defaultPermissionLevel,
        offered: tool.offered ?? false,
        callCount: tool.callCount ?? 0,
      };
      if (tool.offerLocked === true) t.offerLocked = true;
      return t;
    }),
  };
  if (server.errorMessage) {
    row.errorMessage = server.errorMessage;
  }
  return row;
}

function summarizeTransport(transport: McpTransport): string {
  if (transport.type === "stdio") {
    const args = (transport.args ?? []).join(" ");
    return args
      ? `stdio: ${transport.command} ${args}`
      : `stdio: ${transport.command}`;
  }
  return `http: ${transport.url}`;
}

function patchToolPermission(
  groups: ToolsTableGroup[],
  updated: {
    name: string;
    permissionLevel: ToolsPermissionLevel;
    defaultPermissionLevel: ToolsPermissionLevel;
    offered?: boolean;
    offerLocked?: boolean;
    callCount?: number;
  },
): void {
  for (const group of groups) {
    const tool = group.tools.find((t) => t.name === updated.name);
    if (!tool) continue;
    tool.permissionLevel = updated.permissionLevel;
    tool.defaultPermissionLevel = updated.defaultPermissionLevel;
    if (typeof updated.offered === "boolean") tool.offered = updated.offered;
    if (updated.offerLocked !== undefined) tool.offerLocked = updated.offerLocked;
    if (typeof updated.callCount === "number") tool.callCount = updated.callCount;
    return;
  }
}

function patchMcpToolPermission(
  servers: McpServerRuntime[],
  updated: {
    name: string;
    permissionLevel: ToolsPermissionLevel;
    defaultPermissionLevel: ToolsPermissionLevel;
    offered?: boolean;
    offerLocked?: boolean;
    callCount?: number;
  },
): void {
  for (const server of servers) {
    const tool = server.tools.find((t) => t.registryName === updated.name);
    if (!tool) continue;
    tool.permissionLevel = updated.permissionLevel;
    tool.defaultPermissionLevel = updated.defaultPermissionLevel;
    if (typeof updated.offered === "boolean") tool.offered = updated.offered;
    if (updated.offerLocked !== undefined) tool.offerLocked = updated.offerLocked;
    if (typeof updated.callCount === "number") tool.callCount = updated.callCount;
    return;
  }
}

function patchToolOffer(
  groups: ToolsTableGroup[],
  updated: {
    name: string;
    offered: boolean;
    offerLocked?: boolean;
    callCount?: number;
  },
): void {
  for (const group of groups) {
    const tool = group.tools.find((t) => t.name === updated.name);
    if (!tool) continue;
    tool.offered = updated.offered;
    if (updated.offerLocked !== undefined) tool.offerLocked = updated.offerLocked;
    if (typeof updated.callCount === "number") tool.callCount = updated.callCount;
    return;
  }
}

function patchMcpToolOffer(
  servers: McpServerRuntime[],
  updated: {
    name: string;
    offered: boolean;
    offerLocked?: boolean;
    callCount?: number;
  },
): void {
  for (const server of servers) {
    const tool = server.tools.find((t) => t.registryName === updated.name);
    if (!tool) continue;
    tool.offered = updated.offered;
    if (updated.offerLocked !== undefined) tool.offerLocked = updated.offerLocked;
    if (typeof updated.callCount === "number") tool.callCount = updated.callCount;
    return;
  }
}

function filterToolGroups(
  groups: ToolsTableGroup[],
  query: string,
): ToolsTableGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;

  const result: ToolsTableGroup[] = [];
  for (const group of groups) {
    const categoryHit =
      group.label.toLowerCase().includes(needle) ||
      group.description.toLowerCase().includes(needle);

    const tools = categoryHit
      ? group.tools
      : group.tools.filter((tool) => toolMatches(tool, needle));

    if (tools.length === 0) continue;
    result.push({ ...group, tools });
  }
  return result;
}

function filterMcpServers(
  servers: McpServerRuntime[],
  query: string,
): McpServerRuntime[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return servers;
  return servers.filter((server) => {
    if (server.name.toLowerCase().includes(needle)) return true;
    if (summarizeTransport(server.transport).toLowerCase().includes(needle)) {
      return true;
    }
    return server.tools.some(
      (tool) =>
        tool.name.toLowerCase().includes(needle) ||
        getMcpToolUiDescription(tool.name, server.name).toLowerCase().includes(needle) ||
        tool.registryName.toLowerCase().includes(needle),
    );
  });
}

function toolMatches(tool: ToolsTableRow, needle: string): boolean {
  return (
    tool.name.toLowerCase().includes(needle) ||
    tool.displayName.toLowerCase().includes(needle) ||
    tool.description.toLowerCase().includes(needle)
  );
}
