import { maintenanceChannel, releaseMatchesChannel } from "./maintenanceChannel.js";
import type { MaintDraft } from "./maintenanceDraft.js";

export const MAINTENANCE_CHECK_TTL_MS = 5 * 60_000;
const RETRY_DELAY_MS = 60_000;

export interface MaintenanceCheckTarget {
  deviceId: string;
  platform: string;
  version: string;
  manifestUrl: string;
}

export interface MaintenanceRelease {
  version: string;
  url: string;
  sha256?: string;
}

export interface MaintenanceCheckState {
  checking: boolean;
  checkedAt: number | null;
  entry: MaintenanceRelease | null;
  error: string | null;
}

interface CheckRecord {
  state: MaintenanceCheckState;
  retryAt: number;
}

/** Page-local cache: never sends an install action. Keys also include the
 * installed version so a device returning after an update gets a fresh read. */
export class MaintenanceReleaseChecker {
  private readonly records = new Map<string, CheckRecord>();

  constructor(
    private readonly request: (target: MaintenanceCheckTarget) => Promise<MaintenanceRelease | null>,
    private readonly now: () => number = Date.now,
  ) {}

  private key(target: MaintenanceCheckTarget): string {
    return JSON.stringify([target.deviceId, target.platform, target.version, target.manifestUrl.trim()]);
  }

  state(target: MaintenanceCheckTarget): MaintenanceCheckState | null {
    return this.records.get(this.key(target))?.state ?? null;
  }

  /** Null means cached / already running. Manual checks bypass only the TTL. */
  check(target: MaintenanceCheckTarget, manual = false): Promise<MaintenanceCheckState> | null {
    const key = this.key(target);
    const previous = this.records.get(key);
    if (previous?.state.checking || (!manual && previous && this.now() < previous.retryAt)) return null;
    const record: CheckRecord = {
      state: {
        checking: true,
        checkedAt: previous?.state.checkedAt ?? null,
        entry: previous?.state.entry ?? null,
        error: null,
      },
      retryAt: 0,
    };
    this.records.set(key, record);
    return Promise.resolve().then(async () => {
      try {
        const channel = maintenanceChannel(target.platform);
        if (!channel) throw new Error(`No release channel for ${target.platform || "this device"}.`);
        const entry = await this.request(target);
        if (!entry) throw new Error(`The manifest has no ${channel} release. Use Fetch latest to retry.`);
        if (!releaseMatchesChannel(entry.url, channel)) {
          throw new Error(`The manifest returned a package for another platform. Nothing was filled.`);
        }
        record.state = { checking: false, checkedAt: this.now(), entry, error: null };
        record.retryAt = this.now() + MAINTENANCE_CHECK_TTL_MS;
      } catch (error) {
        record.state = {
          ...record.state,
          checking: false,
          error: error instanceof Error ? error.message : String(error),
        };
        record.retryAt = this.now() + RETRY_DELAY_MS;
      }
      return record.state;
    });
  }
}

/** Late responses cannot replace edits made during a request. Automatic
 * refreshes also keep custom packages and explicitly edited channel drafts. */
export function canFillMaintenanceRelease(
  before: MaintDraft,
  current: MaintDraft,
  manual: boolean,
  edited: boolean,
): boolean {
  if (before.source !== current.source || before.sha256 !== current.sha256 || before.version !== current.version) return false;
  return manual || (!edited && (!current.source.trim() || !!current.version));
}
