import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readWorkspaceSettings } from "./readWorkspaceSettings.js";
import { withSettingsDefaults } from "./types.js";
import { writeWorkspaceSettingsUnlocked } from "./writeWorkspaceSettings.js";

function minimalSettings() {
  return {
    providers: [
      {
        id: "default",
        name: "Default",
        baseUrl: "https://api.deepseek.com",
        modelId: "deepseek-v4-flash",
      },
    ],
    activeProviderId: "default",
  };
}

/**
 * composerVoiceMode regression: the flag lived in WorkspaceSettings and
 * PATCHABLE_KEYS but was missing from both the write normalizer and the
 * read parser — the toggle never persisted. It must survive the full
 * write → disk → read chain.
 */
describe("composerVoiceMode round trip", () => {
  it("writes and reads composerVoiceMode=true through the real settings file", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice-on-"));
    const written = await writeWorkspaceSettingsUnlocked(root, {
      ...minimalSettings(),
      composerVoiceMode: true,
    });
    assert.equal(written.composerVoiceMode, true);

    const read = await readWorkspaceSettings(root);
    assert.equal(read?.composerVoiceMode, true);
    assert.equal(withSettingsDefaults(read).composerVoiceMode, true);
  });

  it("keeps an explicit composerVoiceMode=false (not sparse-dropped)", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice-off-"));
    await writeWorkspaceSettingsUnlocked(root, {
      ...minimalSettings(),
      composerVoiceMode: false,
    });
    const read = await readWorkspaceSettings(root);
    assert.equal(read?.composerVoiceMode, false);
    assert.equal(withSettingsDefaults(read).composerVoiceMode, false);
  });

  it("defaults composerVoiceMode to false when unset", () => {
    assert.equal(withSettingsDefaults(null).composerVoiceMode, false);
  });
});
