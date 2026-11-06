import { initFullPermissionsEnabled } from "./fullPermissionsState.js";

/** Load workspace settings once and seed process-wide full-permissions flag. */
export async function bootstrapFullPermissionsFromSettings(): Promise<void> {
  const settings = await window.jellybot?.getWorkspaceSettings?.();
  initFullPermissionsEnabled(settings?.fullPermissionsDefault === true);
}
