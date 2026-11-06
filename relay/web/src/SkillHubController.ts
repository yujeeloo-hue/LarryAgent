/** Skill Hub controller — McpHubController's state machine for skills.
 *  Skills carry no transport probes and no secrets; the only extra load is the
 *  detail fetch (SKILL.md body + read-only file chips). */

export type SkillHubSkill = {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  fileCount: number;
  createdAt: number;
};

export type SkillHubFile = { path: string; size: number };

export type SkillHubDetail = SkillHubSkill & {
  body: string;
  files: SkillHubFile[];
};

export type SkillHubSnapshot = {
  status: "ready" | "loading" | "unavailable";
  statusDetail: string | null;
  skills: SkillHubSkill[];
  selectedSkillId: string | null;
  deviceSkillIds: Record<string, string[]>;
};

export type SkillHubChange = "snapshot" | "skill-order";

export type SyncMatch = "add" | "overwrite";

export type DeviceSyncSkill = {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  fileCount: number;
  match: SyncMatch;
};

export type DeviceSyncSkillPending = "preview" | "push" | "pull" | "remove" | null;

export type DeviceSkillOperation = {
  status: "pending" | "done" | "failed";
  action?: SyncMatch;
  error?: string;
};

type DeviceMutation = "push" | "pull" | "remove";

type SkillSnapshot = {
  skills: SkillHubSkill[];
  deviceSkillIds: Record<string, string[]>;
};

export type DeviceSyncSkillPreview = {
  deviceOnline: boolean;
  supportsSync: boolean;
  hubSkills: Array<SkillHubSkill & { match: SyncMatch }>;
  deviceSkills: DeviceSyncSkill[];
  snapshot: SkillSnapshot;
};

export type SkillHubControllerOptions = {
  apiBase: () => string;
  sessionToken: () => string;
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptySnapshot(status: SkillHubSnapshot["status"], detail: string | null): SkillHubSnapshot {
  return {
    status,
    statusDetail: detail,
    skills: [],
    selectedSkillId: null,
    deviceSkillIds: {},
  };
}

function skillMatchKey(name: string): string {
  return name.trim().toLowerCase();
}

function hasSkillMatch(skills: Array<{ name: string }>, target: { name: string }): boolean {
  const key = skillMatchKey(target.name);
  return skills.some((skill) => skillMatchKey(skill.name) === key);
}

export class SkillHubController {
  private snapshot = emptySnapshot("loading", null);
  private listeners = new Set<(change: SkillHubChange) => void>();
  private skillOrderSaving = false;
  private syncPendingByDevice = new Map<string, DeviceSyncSkillPending>();
  private syncErrorByDevice = new Map<string, string | null>();
  private previewByDevice = new Map<string, DeviceSyncSkillPreview>();
  private previewRequests = new Map<string, Promise<DeviceSyncSkillPreview>>();
  private operations = new Map<string, DeviceSkillOperation>();
  private onlineByDevice = new Map<string, boolean>();
  private syncAnnouncements = new Map<string, string>();
  private details = new Map<string, SkillHubDetail>();
  private detailRequests = new Map<string, Promise<SkillHubDetail>>();

  constructor(private readonly options: SkillHubControllerOptions) {}

  getSnapshot(): SkillHubSnapshot {
    return clone(this.snapshot);
  }

  getSyncPending(deviceId: string): DeviceSyncSkillPending {
    return this.syncPendingByDevice.get(deviceId) ?? null;
  }

  getSyncError(deviceId: string): string | null {
    return this.syncErrorByDevice.get(deviceId) ?? null;
  }

  setDeviceOnline(deviceId: string, online: boolean): void {
    this.onlineByDevice.set(deviceId, online);
    const cached = this.previewByDevice.get(deviceId);
    if (cached && cached.deviceOnline !== online) {
      cached.deviceOnline = online;
      this.notify();
    }
  }

  getDeviceSyncPreview(deviceId: string): DeviceSyncSkillPreview | null {
    const cached = this.previewByDevice.get(deviceId);
    if (!cached) return null;
    const preview = clone(cached);
    if (this.onlineByDevice.get(deviceId) === false) preview.deviceOnline = false;
    // Matches describe identity, not equality of content.
    preview.deviceSkills = preview.deviceSkills.map((skill) => ({
      ...skill,
      match: hasSkillMatch(this.snapshot.skills, skill) ? "overwrite" : "add",
    }));
    preview.hubSkills = this.snapshot.skills.map((skill) => ({
      ...skill,
      match: hasSkillMatch(preview.deviceSkills, skill) ? "overwrite" : "add",
    }));
    return preview;
  }

  getDeviceOperation(deviceId: string, kind: DeviceMutation, skillId: string): DeviceSkillOperation | null {
    const operation = this.operations.get(this.operationKey(deviceId, kind, skillId));
    return operation ? { ...operation } : null;
  }

  getSyncAnnouncement(deviceId: string): string {
    return this.syncAnnouncements.get(deviceId) ?? "";
  }

  subscribe(listener: (change: SkillHubChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  selectSkill(skillId: string | null): void {
    if (skillId && !this.snapshot.skills.some((item) => item.id === skillId)) return;
    if (this.snapshot.selectedSkillId === skillId) return;
    this.snapshot.selectedSkillId = skillId;
    this.notify();
  }

  isSkillOrderSaving(): boolean {
    return this.skillOrderSaving;
  }

  async reorderSkills(skillIds: string[]): Promise<void> {
    if (this.skillOrderSaving) throw new Error("Skill order is still saving.");
    const current = this.snapshot.skills.map((skill) => skill.id);
    const ids = new Set(skillIds);
    if (
      this.snapshot.status !== "ready" ||
      skillIds.length !== current.length ||
      ids.size !== current.length ||
      current.some((id) => !ids.has(id))
    ) {
      throw new Error("Skills changed. Refresh the list and try again.");
    }
    if (current.every((id, index) => id === skillIds[index])) return;
    this.skillOrderSaving = true;
    try {
      const result = await this.request<SkillSnapshot>("/skills/reorder", {
        method: "POST",
        body: JSON.stringify({ skillIds }),
      });
      this.skillOrderSaving = false;
      this.apply(result, undefined, "skill-order");
    } finally {
      this.skillOrderSaving = false;
    }
  }

  async refresh(): Promise<void> {
    if (!this.options.sessionToken()) {
      this.snapshot = emptySnapshot("unavailable", "Sign in required.");
      this.notify();
      return;
    }
    try {
      this.apply(await this.request<SkillSnapshot>(""));
    } catch (err) {
      this.snapshot = emptySnapshot("unavailable", err instanceof Error ? err.message : String(err));
      this.notify();
    }
  }

  async addSkill(input: { name: string; description: string; body: string; enabled?: boolean }): Promise<void> {
    const created = await this.request<SkillSnapshot>("/skills", {
      method: "POST",
      body: JSON.stringify({
        skills: [{
          name: input.name,
          description: input.description,
          body: input.body,
          enabled: input.enabled !== false,
        }],
      }),
    });
    const newest = created.skills.find(
      (skill) => skillMatchKey(skill.name) === skillMatchKey(input.name),
    )?.id ?? created.skills[created.skills.length - 1]?.id;
    this.apply(created, newest);
  }

  async updateSkill(
    skillId: string,
    patch: { name?: string; description?: string; body?: string; enabled?: boolean },
  ): Promise<void> {
    const result = await this.request<SkillSnapshot>(`/skills/${encodeURIComponent(skillId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    this.invalidateDetail(skillId);
    this.apply(result, skillId);
  }

  async removeSkill(skillId: string): Promise<void> {
    const result = await this.request<SkillSnapshot>(`/skills/${encodeURIComponent(skillId)}`, {
      method: "DELETE",
    });
    this.invalidateDetail(skillId);
    this.apply(result);
  }

  getDetail(skillId: string): SkillHubDetail | null {
    const detail = this.details.get(skillId);
    return detail ? clone(detail) : null;
  }

  loadDetail(skillId: string): Promise<SkillHubDetail> {
    const cached = this.details.get(skillId);
    if (cached) return Promise.resolve(clone(cached));
    const inFlight = this.detailRequests.get(skillId);
    if (inFlight) return inFlight.then((detail) => clone(detail));
    const request = this.request<SkillHubDetail>(`/skills/${encodeURIComponent(skillId)}`)
      .then((detail) => {
        this.details.set(skillId, detail);
        return detail;
      })
      .finally(() => this.detailRequests.delete(skillId));
    this.detailRequests.set(skillId, request);
    return request.then((detail) => clone(detail));
  }

  invalidateDetail(skillId: string): void {
    this.details.delete(skillId);
  }

  loadDeviceSyncPreview(deviceId: string): Promise<DeviceSyncSkillPreview> {
    const inFlight = this.previewRequests.get(deviceId);
    if (inFlight) return inFlight;
    if (this.getSyncPending(deviceId)) {
      return Promise.reject(new Error("A skill operation is still running."));
    }
    this.clearDeviceOperations(deviceId);
    const request = this.fetchDevicePreview(deviceId)
      .then(() => {
        this.setSyncState(deviceId, null, null);
        return this.getDeviceSyncPreview(deviceId)!;
      })
      .catch((err: unknown) => {
        this.setSyncState(deviceId, null, formatSyncError(err));
        throw err;
      })
      .finally(() => this.previewRequests.delete(deviceId));
    this.previewRequests.set(deviceId, request);
    this.setSyncState(deviceId, "preview", null);
    return request;
  }

  async pushSkillToDevice(deviceId: string, skillId: string): Promise<{ action: SyncMatch }> {
    return this.mutateDevice(deviceId, "push", skillId, async () => {
      const result = await this.request<{
        action: string;
        deviceSkillId: string | null;
        fileCount: number;
        snapshot: SkillSnapshot;
      }>(`/devices/${encodeURIComponent(deviceId)}/push`, {
        method: "POST",
        body: JSON.stringify({ skillId }),
      });
      this.apply(result.snapshot);
      const cached = this.previewByDevice.get(deviceId);
      const skill = this.snapshot.skills.find((item) => item.id === skillId);
      if (cached && skill && result.deviceSkillId) {
        const existing = cached.deviceSkills.findIndex((item) => item.id === result.deviceSkillId);
        const transferred: DeviceSyncSkill = {
          id: result.deviceSkillId,
          name: skill.name,
          enabled: skill.enabled,
          description: skill.description,
          fileCount: result.fileCount,
          match: "overwrite",
        };
        if (existing >= 0) cached.deviceSkills[existing] = transferred;
        else cached.deviceSkills.push(transferred);
        this.operations.delete(this.operationKey(deviceId, "pull", result.deviceSkillId));
      }
      return { action: result.action === "overwritten" ? "overwrite" : "add" };
    });
  }

  async pullSkillFromDevice(deviceId: string, deviceSkillId: string): Promise<{ action: SyncMatch }> {
    return this.mutateDevice(deviceId, "pull", deviceSkillId, async () => {
      const result = await this.request<{ action: string; skillId: string; snapshot: SkillSnapshot }>(
        `/devices/${encodeURIComponent(deviceId)}/pull`,
        { method: "POST", body: JSON.stringify({ skillId: deviceSkillId }) },
      );
      this.apply(result.snapshot);
      this.invalidateDetail(result.skillId);
      return { action: result.action === "overwritten" ? "overwrite" : "add" };
    });
  }

  async removeSkillFromDevice(deviceId: string, deviceSkillId: string): Promise<void> {
    await this.mutateDevice(deviceId, "remove", deviceSkillId, async () => {
      const result = await this.request<{ removed: boolean; snapshot: SkillSnapshot }>(
        `/devices/${encodeURIComponent(deviceId)}/remove`,
        { method: "POST", body: JSON.stringify({ skillId: deviceSkillId }) },
      );
      this.apply(result.snapshot);
      const cached = this.previewByDevice.get(deviceId);
      const removed = cached?.deviceSkills.find((item) => item.id === deviceSkillId);
      if (cached) cached.deviceSkills = cached.deviceSkills.filter((item) => item.id !== deviceSkillId);
      if (removed) {
        for (const skill of this.snapshot.skills) {
          if (hasSkillMatch([removed], skill)) {
            this.operations.delete(this.operationKey(deviceId, "push", skill.id));
          }
        }
      }
      this.operations.delete(this.operationKey(deviceId, "pull", deviceSkillId));
      return {};
    });
  }

  private async fetchDevicePreview(deviceId: string): Promise<void> {
    const preview = await this.request<DeviceSyncSkillPreview>(
      `/devices/${encodeURIComponent(deviceId)}/sync-preview`,
    );
    // An offline response has no device data; retain the last real list.
    if (preview.deviceOnline || !this.previewByDevice.has(deviceId)) {
      this.previewByDevice.set(deviceId, preview);
    } else {
      this.previewByDevice.get(deviceId)!.deviceOnline = false;
    }
    if (preview.snapshot) this.apply(preview.snapshot);
  }

  private async mutateDevice<T extends { action?: SyncMatch }>(
    deviceId: string,
    kind: DeviceMutation,
    skillId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.getSyncPending(deviceId)) throw new Error("A skill operation is still running.");
    const key = this.operationKey(deviceId, kind, skillId);
    const name = (
      kind === "push" ? this.snapshot.skills : this.previewByDevice.get(deviceId)?.deviceSkills
    )?.find((skill) => skill.id === skillId)?.name ?? "Skill";
    this.syncAnnouncements.set(
      deviceId,
      `${kind === "push" ? "Adding" : kind === "pull" ? "Copying" : "Deleting"} ${name}…`,
    );
    this.operations.set(key, { status: "pending" });
    this.setSyncState(deviceId, kind, null);
    let result: T;
    try {
      result = await work();
    } catch (err) {
      const message = formatSyncError(err);
      this.operations.set(key, { status: "failed", error: message });
      this.syncAnnouncements.set(deviceId, `${name}: ${message}`);
      this.setSyncState(deviceId, null, message);
      throw new Error(message);
    }
    // A failed read after a committed mutation must not invite a duplicate retry.
    let reloadError: string | null = null;
    try {
      await this.fetchDevicePreview(deviceId);
    } catch (err) {
      reloadError = `Change saved. Could not reload device skills: ${formatSyncError(err)}`;
    }
    this.operations.set(key, { status: "done", action: result.action });
    this.syncAnnouncements.set(
      deviceId,
      `${kind === "push"
        ? (result.action === "overwrite" ? "Replaced" : "Added")
        : kind === "pull"
          ? "Copied to Relay:"
          : "Deleted"} ${name}.`,
    );
    this.setSyncState(deviceId, null, reloadError);
    return result;
  }

  private operationKey(deviceId: string, kind: DeviceMutation, skillId: string): string {
    return JSON.stringify([deviceId, kind, skillId]);
  }

  private clearDeviceOperations(deviceId: string): void {
    for (const key of this.operations.keys()) {
      if ((JSON.parse(key) as string[])[0] === deviceId) this.operations.delete(key);
    }
  }

  private setSyncState(
    deviceId: string,
    pending: DeviceSyncSkillPending,
    error: string | null,
  ): void {
    this.syncPendingByDevice.set(deviceId, pending);
    this.syncErrorByDevice.set(deviceId, error);
    this.notify();
  }

  private apply(skillSnapshot: SkillSnapshot, selectId?: string, change: SkillHubChange = "snapshot"): void {
    const selected = selectId ?? this.snapshot.selectedSkillId;
    this.snapshot = {
      status: "ready",
      statusDetail: null,
      skills: skillSnapshot.skills,
      deviceSkillIds: skillSnapshot.deviceSkillIds ?? {},
      selectedSkillId: skillSnapshot.skills.some((item) => item.id === selected)
        ? selected
        : skillSnapshot.skills[0]?.id ?? null,
    };
    this.notify(change);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.options.sessionToken();
    if (!token) throw new Error("Sign in required.");
    const res = await fetch(`${this.options.apiBase()}api/console/skill-hub${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-auth-token": token,
      },
    });
    const data = await res.json().catch(() => ({})) as {
      error?: string;
      detail?: string;
    };
    if (!res.ok) {
      if (data.error === "device_update_required") {
        throw new Error(typeof data.detail === "string"
          ? data.detail
          : "Update this device to manage skills remotely.");
      }
      const error = typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
      throw new Error(typeof data.detail === "string" ? data.detail : error);
    }
    return data as T;
  }

  private notify(change: SkillHubChange = "snapshot"): void {
    for (const listener of this.listeners) listener(change);
  }
}

function formatSyncError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
