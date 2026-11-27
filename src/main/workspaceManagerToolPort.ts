import { mkdir, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type {
  WorkspaceManagerCreateResult,
  WorkspaceManagerPort,
  WorkspaceManagerRenameResult,
} from "../tools/workspaceManagerPort.js";
import type { SessionStore } from "./sessionRuntime.js";

export function createWorkspaceManagerPort(
  store: Pick<SessionStore, "listWorkspaces" | "createWorkspace" | "updateWorkspace">,
): WorkspaceManagerPort {
  return {
    async create({ name, path }): Promise<WorkspaceManagerCreateResult> {
      const normalized = resolve(path);
      const known = store
        .listWorkspaces()
        .find((workspace) => resolve(workspace.path) === normalized);
      if (known) {
        return {
          id: known.id,
          name: known.name,
          path: known.path,
          existing: true,
        };
      }

      const info = await stat(normalized).catch(() => null);
      if (info && !info.isDirectory()) {
        throw new Error("path exists and is not a folder");
      }
      if (!info) await mkdir(normalized, { recursive: true });

      const workspace = await store.createWorkspace({
        name,
        path: normalized,
      });
      return {
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        existing: false,
      };
    },

    async rename({ id, path, name }): Promise<WorkspaceManagerRenameResult> {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Workspace name is required");
      const normalizedId = id?.trim();
      const normalizedPath = path ? resolve(path) : "";
      const existing = store.listWorkspaces().find(
        (workspace) =>
          (normalizedId ? workspace.id === normalizedId : false) ||
          (normalizedPath ? resolve(workspace.path) === normalizedPath : false),
      );
      if (!existing) {
        throw new Error("Workspace is not registered on this device");
      }
      const workspace = await store.updateWorkspace({ id: existing.id, name: trimmed });
      return {
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        previousName: existing.name,
      };
    },
  };
}
