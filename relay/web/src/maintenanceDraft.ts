import {
  MAINTENANCE_CHANNELS,
  releaseChannelOfFile,
  type MaintenanceChannel,
} from "./maintenanceChannel.js";

export const DEFAULT_MANIFEST_URL = "https://larryagent.online/download/downloads.json";

export interface MaintDraft {
  source: string;
  sha256: string;
  version?: string;
}
export interface MaintStore {
  manifestUrl: string;
  force: boolean;
  drafts: Record<MaintenanceChannel, MaintDraft>;
}
export interface MaintFormPatch {
  source?: string;
  sha256?: string;
  version?: string;
  manifestUrl?: string;
  force?: boolean;
}

export const EMPTY_DRAFT: MaintDraft = { source: "", sha256: "" };

function emptyDrafts(): Record<MaintenanceChannel, MaintDraft> {
  return { mac: { ...EMPTY_DRAFT }, win: { ...EMPTY_DRAFT }, agentd: { ...EMPTY_DRAFT } };
}

function readDraft(raw: Record<string, unknown>): MaintDraft {
  const source = typeof raw.source === "string" ? raw.source : "";
  return {
    source,
    sha256: typeof raw.sha256 === "string" ? raw.sha256 : "",
    ...(typeof raw.version === "string" && raw.version && source ? { version: raw.version } : {}),
  };
}

export function emptyMaintStore(): MaintStore {
  return { manifestUrl: DEFAULT_MANIFEST_URL, force: false, drafts: emptyDrafts() };
}

export function parseMaintStore(raw: string | null): MaintStore {
  const store = emptyMaintStore();
  if (!raw) return store;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return store;
    parsed = value as Record<string, unknown>;
  } catch {
    return store;
  }
  if (typeof parsed.manifestUrl === "string" && parsed.manifestUrl) store.manifestUrl = parsed.manifestUrl;
  store.force = parsed.force === true;
  if (parsed.drafts && typeof parsed.drafts === "object") {
    for (const channel of MAINTENANCE_CHANNELS) {
      const draft = (parsed.drafts as Record<string, unknown>)[channel];
      if (draft && typeof draft === "object") store.drafts[channel] = readDraft(draft as Record<string, unknown>);
    }
    return store;
  }
  const legacy = readDraft(parsed);
  const channel = legacy.source ? releaseChannelOfFile(legacy.source) : null;
  if (channel) store.drafts[channel] = legacy;
  return store;
}

export function draftFor(store: MaintStore, channel: MaintenanceChannel | null): MaintDraft {
  return channel ? store.drafts[channel] : EMPTY_DRAFT;
}

export function applyDraftPatch(
  store: MaintStore,
  channel: MaintenanceChannel | null,
  patch: MaintFormPatch,
): MaintStore {
  const next: MaintStore = {
    manifestUrl: patch.manifestUrl !== undefined ? patch.manifestUrl : store.manifestUrl,
    force: patch.force !== undefined ? patch.force : store.force,
    drafts: { ...store.drafts },
  };
  if (!channel) return next;
  const draft: MaintDraft = { ...store.drafts[channel] };
  if (patch.source !== undefined) draft.source = patch.source;
  if (patch.sha256 !== undefined) draft.sha256 = patch.sha256;
  if ("version" in patch) {
    if (patch.version) draft.version = patch.version;
    else delete draft.version;
  }
  next.drafts[channel] = draft;
  return next;
}

export function withDraft(
  store: MaintStore,
  channel: MaintenanceChannel,
  draft: MaintDraft,
): MaintStore {
  return { ...store, drafts: { ...store.drafts, [channel]: { ...draft } } };
}
