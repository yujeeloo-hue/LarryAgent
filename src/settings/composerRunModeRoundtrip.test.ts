import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readWorkspaceSettings } from "./readWorkspaceSettings.js";
import { WORKSPACE_SETTINGS_FILE, normalizeComposerRunMode, withSettingsDefaults } from "./types.js";
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

describe("composerRunMode ask round trip", () => {
  it("writes and reads ask through the real settings file", async () => {
    const root = mkdtempSync(join(tmpdir(), "runmode-ask-"));
    const written = await writeWorkspaceSettingsUnlocked(root, {
      ...minimalSettings(),
      composerRunMode: "ask",
    });
    assert.equal(written.composerRunMode, "ask");

    const read = await readWorkspaceSettings(root);
    assert.equal(read?.composerRunMode, "ask");

    const resolved = withSettingsDefaults(read);
    assert.equal(resolved.composerRunMode, "ask");
  });

  it("normalizes legacy infinite to plan and unknown values to agent", () => {
    assert.equal(normalizeComposerRunMode("ask"), "ask");
    assert.equal(normalizeComposerRunMode("agent"), "agent");
    assert.equal(normalizeComposerRunMode("plan"), "plan");
    assert.equal(normalizeComposerRunMode("infinite"), "plan");
    assert.equal(normalizeComposerRunMode("turbo"), "agent");
    assert.equal(normalizeComposerRunMode(undefined), "agent");
  });
});

describe("composerInfinite switch round trip", () => {
  it("writes and reads composerInfinite through the real settings file", async () => {
    const root = mkdtempSync(join(tmpdir(), "infinite-on-"));
    const written = await writeWorkspaceSettingsUnlocked(root, {
      ...minimalSettings(),
      composerInfinite: true,
    });
    assert.equal(written.composerInfinite, true);

    const read = await readWorkspaceSettings(root);
    assert.equal(read?.composerInfinite, true);
    const resolved = withSettingsDefaults(read);
    assert.equal(resolved.composerInfinite, true);

    const off = await writeWorkspaceSettingsUnlocked(root, {
      ...minimalSettings(),
      composerInfinite: false,
    });
    assert.equal(off.composerInfinite, false);
    assert.equal(
      withSettingsDefaults(await readWorkspaceSettings(root)).composerInfinite,
      false,
    );
  });

  it("defaults composerInfinite to false when unset", () => {
    assert.equal(withSettingsDefaults(null).composerInfinite, false);
  });

  it("migrates legacy composerRunMode=infinite to plan + switch on", async () => {
    const root = mkdtempSync(join(tmpdir(), "infinite-mig-"));
    writeFileSync(
      join(root, WORKSPACE_SETTINGS_FILE),
      JSON.stringify({
        ...minimalSettings(),
        composerRunMode: "infinite",
      }),
      "utf8",
    );

    const read = await readWorkspaceSettings(root);
    assert.equal(read?.composerRunMode, "plan");
    assert.equal(read?.composerInfinite, true);
  });

  it("keeps an explicit composerInfinite=false during legacy migration", async () => {
    const root = mkdtempSync(join(tmpdir(), "infinite-mig-off-"));
    writeFileSync(
      join(root, WORKSPACE_SETTINGS_FILE),
      JSON.stringify({
        ...minimalSettings(),
        composerRunMode: "infinite",
        composerInfinite: false,
      }),
      "utf8",
    );

    const read = await readWorkspaceSettings(root);
    assert.equal(read?.composerRunMode, "plan");
    assert.equal(read?.composerInfinite, false);
  });
});
