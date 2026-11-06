/**
 * The Maintenance card's update draft, keyed per release channel.
 *
 * The downloads manifest carries one entry per platform (mac / win / agentd)
 * and those entries do not move in lock-step — a Windows build can be a
 * release ahead of the mac zip, which is ahead of the agentd tarball. A single
 * shared draft therefore leaked one platform's URL, sha256 and — the visible
 * symptom — version into another platform's card: the "1.5.2 → 1.5.3" arrow,
 * the "already installed → Reinstall" guard and the `version` handed to the
 * device's reconciler all judged the wrong release, and Update could push a
 * Windows setup at a Mac.
 *
 * So: `manifestUrl` and `force` are platform-independent and global; the
 * release (`source` / `sha256` / `version`) lives in exactly one channel's
 * draft. Nothing here touches the DOM or localStorage — the caller owns
 * persistence, which keeps the migration testable.
 */
import {
  MAINTENANCE_CHANNELS,
  releaseChannelOfFile,
  type MaintenanceChannel,
} from "./maintenanceChannel.js";

export const DEFAULT_MANIFEST_URL = "https://larryagent.online/download/downloads.json";

export interface MaintDraft {
  source: string;
  sha256: string;
  /** Manifest version belongs to this source; manual source edits clear it. */
  version?: string;
}
export interface MaintStore {
  manifestUrl: string;
  force: boolean;
  drafts: Record<MaintenanceChannel, MaintDraft>;
}
/** The shape the card renders / patches (see DeviceMaintenancePanel["form"]). */
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

/**
 * Parse the persisted draft. Accepts the legacy single-platform shape (v1) by
 * filing it under the channel its filename names — a saved win setup never
 * resurfaces on the mac/agentd cards. Unrecognised legacy names are dropped
 * (the operator re-fetches) rather than guessed onto every platform.
 */
export function parseMaintStore(raw: string | null): MaintStore {
  const store = emptyMaintStore();
  if (!raw) return store;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return store;
    parsed = value as Record<string, unknown>;
  } catch {
    return store; // private mode / corrupt value → defaults
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

/** Draft for the device's channel — an unknown platform has no draft at all. */
export function draftFor(store: MaintStore, channel: MaintenanceChannel | null): MaintDraft {
  return channel ? store.drafts[channel] : EMPTY_DRAFT;
}

/** Form edits: manifest URL / force update globally, release fields per channel. */
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
  // Editing the release (source/sha256) drops the manifest version so the card
  // never compares a stale version against a hand-typed package.
  if ("version" in patch) {
    if (patch.version) draft.version = patch.version;
    else delete draft.version;
  }
  next.drafts[channel] = draft;
  return next;
}

/** Store a manifest result in one channel — the other platforms stay untouched. */
export function withDraft(
  store: MaintStore,
  channel: MaintenanceChannel,
  draft: MaintDraft,
): MaintStore {
  return { ...store, drafts: { ...store.drafts, [channel]: { ...draft } } };
}
