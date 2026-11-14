import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { patchWorkspaceSettings } from "./patchWorkspaceSettings.js";
import { readWorkspaceSettings } from "./readWorkspaceSettings.js";
import {
  normalizeFontScale,
  resolveChatFontScale,
  resolveUiFontScale,
  resolvedToWorkspaceSettings,
  withSettingsDefaults,
  type WorkspaceSettings,
} from "./types.js";

/** Partial literal → WorkspaceSettings (resolver inputs in tests). */
const ws = (overrides: Record<string, unknown>): WorkspaceSettings =>
  overrides as unknown as WorkspaceSettings;
import { writeWorkspaceSettingsUnlocked } from "./writeWorkspaceSettings.js";

describe("font scale settings", () => {
  it("defaults to 1 (100%) when unset", () => {
    const resolved = withSettingsDefaults(null);
    assert.equal(resolved.uiFontScale, 1);
    assert.equal(resolved.chatFontScale, 1);
  });

  it("normalizeFontScale clamps and rejects invalid values", () => {
    assert.equal(normalizeFontScale(1.15), 1.15);
    assert.equal(normalizeFontScale("1.15"), 1);
    assert.equal(normalizeFontScale(Number.NaN), 1);
    assert.equal(normalizeFontScale(Number.POSITIVE_INFINITY), 1);
    assert.equal(normalizeFontScale(undefined), 1);
    assert.equal(normalizeFontScale(0.1, 1, 0.8, 1.5), 0.8);
    assert.equal(normalizeFontScale(9, 1, 0.8, 1.5), 1.5);
    // Out-of-range numbers clamp (not fall back); fallback is for non-numbers.
    assert.equal(normalizeFontScale(0.5, 1.2, 0.8, 1.5), 0.8);
  });

  it("resolvers use per-knob ranges (ui 0.8–1.5, chat 0.8–1.6)", () => {
    assert.equal(resolveUiFontScale(ws({ uiFontScale: 1.6 })), 1.5);
    assert.equal(resolveChatFontScale(ws({ chatFontScale: 1.6 })), 1.6);
    assert.equal(resolveUiFontScale(ws({ uiFontScale: 0.5 })), 0.8);
    assert.equal(resolveChatFontScale(ws({ chatFontScale: "big" })), 1);
  });

  it("resolved → writable payload keeps non-default scales, omits 1", () => {
    const resolved = withSettingsDefaults(null);
    const payload = resolvedToWorkspaceSettings(resolved);
    assert.equal("uiFontScale" in payload, false);
    assert.equal("chatFontScale" in payload, false);

    const scaled = withSettingsDefaults(
      ws({ uiFontScale: 1.15, chatFontScale: 1.25 }),
    );
    const scaledPayload = resolvedToWorkspaceSettings(scaled);
    assert.equal(scaledPayload.uiFontScale, 1.15);
    assert.equal(scaledPayload.chatFontScale, 1.25);
  });

  it("writes and reads both scales through the real settings file", async () => {
    const root = mkdtempSync(join(tmpdir(), "font-scale-roundtrip-"));
    await writeWorkspaceSettingsUnlocked(root, {
      providers: [
        {
          id: "default",
          name: "Default",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-4o-mini",
        },
      ],
      activeProviderId: "default",
      uiFontScale: 1.15,
      chatFontScale: 1.25,
    });

    const read = await readWorkspaceSettings(root);
    assert.equal(read?.uiFontScale, 1.15);
    assert.equal(read?.chatFontScale, 1.25);

    const resolved = withSettingsDefaults(read);
    assert.equal(resolved.uiFontScale, 1.15);
    assert.equal(resolved.chatFontScale, 1.25);
  });

  it("patchWorkspaceSettings accepts the two keys sparsely", async () => {
    const root = mkdtempSync(join(tmpdir(), "font-scale-patch-"));
    await writeWorkspaceSettingsUnlocked(root, {
      providers: [
        {
          id: "default",
          name: "Default",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-4o-mini",
        },
      ],
      activeProviderId: "default",
    });

    const patched = await patchWorkspaceSettings(root, { chatFontScale: 1.1 });
    assert.equal(patched.chatFontScale, 1.1);
    assert.equal(patched.uiFontScale, 1);
    const onDisk = await readWorkspaceSettings(root);
    assert.equal(onDisk?.chatFontScale, 1.1);
    assert.equal("uiFontScale" in (onDisk ?? {}), false);

    const reset = await patchWorkspaceSettings(root, { uiFontScale: 0.9 });
    assert.equal(reset.uiFontScale, 0.9);
    assert.equal(reset.chatFontScale, 1.1);
  });
});
