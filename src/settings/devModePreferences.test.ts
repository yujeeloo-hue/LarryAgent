import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_DEV_MODE_PREFERENCES, normalizeDevModePreferences } from "./devModePreferences.js";
import { patchWorkspaceSettings } from "./patchWorkspaceSettings.js";
import { readWorkspaceSettings } from "./readWorkspaceSettings.js";
import { withSettingsDefaults } from "./types.js";

test("Dev Mode defaults and safe font limits", () => {
  assert.deepEqual(withSettingsDefaults(null).devMode, DEFAULT_DEV_MODE_PREFERENCES);
  assert.deepEqual(normalizeDevModePreferences({ fontFamily: "__proto__", fontSize: 900, syntaxTheme: "unknown" }), {
    ...DEFAULT_DEV_MODE_PREFERENCES, fontSize: 40,
  });
});

test("Live Coding stays off unless it is explicitly enabled", () => {
  assert.equal(DEFAULT_DEV_MODE_PREFERENCES.liveCoding, false);
  assert.equal(normalizeDevModePreferences({}).liveCoding, false);
  assert.equal(normalizeDevModePreferences({ liveCoding: "true" }).liveCoding, false);
  assert.equal(normalizeDevModePreferences({ liveCoding: true }).liveCoding, true);
});

test("Dev Mode preference patches merge independently and round-trip to disk", async () => {
  const root = await mkdtemp(join(tmpdir(), "dev-mode-preferences-"));
  try {
    await patchWorkspaceSettings(root, { devMode: { precompile: false } });
    await patchWorkspaceSettings(root, { devMode: { liveCoding: true } });
    await patchWorkspaceSettings(root, { devMode: { fontFamily: "jetbrains", fontSize: 16.5, syntaxTheme: "light" } });
    await patchWorkspaceSettings(root, { virtualCursorEnabled: false, themeId: "dark" });
    const result = withSettingsDefaults(await readWorkspaceSettings(root));
    assert.deepEqual(result.devMode, { precompile: false, liveCoding: true, fontFamily: "jetbrains", fontSize: 16.5, syntaxTheme: "light" });
    assert.equal(result.virtualCursorEnabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
