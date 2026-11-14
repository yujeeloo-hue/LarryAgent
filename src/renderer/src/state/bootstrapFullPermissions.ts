import { initAutoSkillSummarizeEnabled } from "./autoSkillSummarizeState.js";
import { initFullPermissionsEnabled } from "./fullPermissionsState.js";

/** Load workspace settings once and seed the process-wide Bypass permissions / Self-learning flags. */
export async function bootstrapFullPermissionsFromSettings(): Promise<void> {
  const settings = await window.jellybot?.getWorkspaceSettings?.();
  initFullPermissionsEnabled(settings?.fullPermissionsDefault === true);
  initAutoSkillSummarizeEnabled(settings?.autoSkillSummarizeDefault === true);
}
