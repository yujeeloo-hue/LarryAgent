/**
 * Sparse settings.json patches under a write lock.
 * Composer Infinite/Max toggles and Setting card autosaves must use this so
 * concurrent full rewrites cannot wipe providers.
 */
import { readWorkspaceSettings } from "./readWorkspaceSettings.js";
import {
  resolvedToWorkspaceSettings,
  withSettingsDefaults,
  type ResolvedWorkspaceSettings,
  type WorkspaceSettings,
} from "./types.js";
import {
  withSettingsWriteLock,
  writeWorkspaceSettingsUnlocked,
} from "./writeWorkspaceSettings.js";

/**
 * Sparse-patchable settings.json keys (exported for the round-trip tripwire
 * test — every key here must survive normalize → parse round-trips, else
 * persistence silently drops it, cf. composerVoiceMode).
 */
export const PATCHABLE_KEYS = [
  "providers",
  "activeProviderId",
  "visionProviderId",
  "inlineCompletionProviderId",
  "imageGenProviders",
  "activeImageGenProviderId",
  "objectStorage",
  "fullPermissionsDefault",
  "autoSkillSummarizeDefault",
  "composerRunMode",
  "composerInfinite",
  "reasoningEffort",
  "composerVoiceMode",
  "contextLimitTokens",
  "compactTriggerRatio",
  "iterationProtectRawIterationCount",
  "iterationProtectTokenRatio",
  "maxModelIterations",
  "maxTurnTokens",
  "llmRequestTimeoutMs",
  "activeWorkspaceId",
  "debugAdapterPath",
  "environmentContext",
  "userMemoryAutoExtract",
  "projectMemoryAutoExtract",
  "toolStatsEnabled",
  "themeId",
  "accentColor",
  "uiFontScale",
  "chatFontScale",
  "remote",
] as const;

/**
 * Apply a sparse patch onto on-disk settings under a write lock.
 * Only keys present on `patch` are overwritten.
 */
export async function patchWorkspaceSettings(
  appDataRoot: string,
  patch: Record<string, unknown>,
): Promise<ResolvedWorkspaceSettings> {
  return withSettingsWriteLock(async () => {
    const currentRaw = await readWorkspaceSettings(appDataRoot);
    const current = withSettingsDefaults(currentRaw);
    const merged: WorkspaceSettings = resolvedToWorkspaceSettings(current);

    for (const key of PATCHABLE_KEYS) {
      if (!(key in patch)) continue;
      (merged as Record<string, unknown>)[key] = patch[key];
    }

    if ("providers" in patch && Array.isArray(patch.providers)) {
      const before = current.providers.map((p) => p.id).join(",");
      const after = (patch.providers as { id?: string }[])
        .map((p) => p.id ?? "")
        .join(",");
      if (before !== after) {
        console.warn(
          `[settings] providers list changed (${current.providers.length} → ${(patch.providers as unknown[]).length}) ids=${after}`,
        );
      }
    }

    const saved = await writeWorkspaceSettingsUnlocked(appDataRoot, merged);
    return withSettingsDefaults(saved);
  });
}

/**
 * Disable one provider's opt-in Responses state without racing a full
 * providers form save. Returns true only when an explicit enabled value was
 * actually changed; unset values already resolve to false.
 */
export async function disableResponsesStateful(
  appDataRoot: string,
  providerId: string,
): Promise<boolean> {
  const wanted = providerId.trim();
  if (!wanted) return false;
  return withSettingsWriteLock(async () => {
    const current = withSettingsDefaults(await readWorkspaceSettings(appDataRoot));
    if (current.providers.find((provider) => provider.id === wanted)?.responsesStateful !== true) {
      return false;
    }
    const merged = resolvedToWorkspaceSettings(current);
    merged.providers = merged.providers.map((provider) => provider.id === wanted
      ? { ...provider, responsesStateful: false }
      : provider);
    await writeWorkspaceSettingsUnlocked(appDataRoot, merged);
    return true;
  });
}
