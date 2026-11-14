import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseWorkspaceSettings, readWorkspaceSettings } from "./readWorkspaceSettings.js";
import { patchWorkspaceSettings } from "./patchWorkspaceSettings.js";
import {
  ACCENT_COLOR_PRESET_IDS,
  resolveAccentColor,
  withSettingsDefaults,
} from "./types.js";
import { normalizeWorkspaceSettings } from "./writeWorkspaceSettings.js";
// Renderer's visual source of truth (pure module, no DOM) — keeps the
// persisted preset-id contract in sync with the picker.
import { ACCENT_PRESETS } from "../renderer/src/state/theme.js";

const BASE = {
  providers: [
    {
      id: "default",
      name: "Default",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-mini",
    },
  ],
  activeProviderId: "default",
};

describe("accentColor settings", () => {
  it("preset id contract mirrors the renderer picker", () => {
    assert.deepEqual(
      ACCENT_COLOR_PRESET_IDS,
      ACCENT_PRESETS.map((p) => p.id),
    );
  });

  it("defaults to Auto (null) when unset or invalid", () => {
    assert.equal(resolveAccentColor(null), null);
    assert.equal(resolveAccentColor({ ...BASE } as never), null);
    assert.equal(resolveAccentColor({ ...BASE, accentColor: "solar" } as never), null);
    assert.equal(resolveAccentColor({ ...BASE, accentColor: "#12g345" } as never), null);
    assert.equal(resolveAccentColor({ ...BASE, accentColor: 42 } as never), null);
  });

  it("keeps preset ids and lowercases custom hex", () => {
    assert.equal(resolveAccentColor({ ...BASE, accentColor: "violet" } as never), "violet");
    assert.equal(
      resolveAccentColor({ ...BASE, accentColor: "#A855F7" } as never),
      "#a855f7",
    );
  });

  it("survives parse → defaults round trip", () => {
    const parsed = parseWorkspaceSettings(
      JSON.stringify({ ...BASE, accentColor: "rose" }),
    );
    assert.ok(parsed);
    assert.equal(withSettingsDefaults(parsed).accentColor, "rose");
  });

  it("normalization drops invalid values (persistence whitelist)", () => {
    const normalized = normalizeWorkspaceSettings({
      ...BASE,
      accentColor: "solar",
    });
    assert.ok(normalized);
    assert.equal(normalized!.accentColor, undefined);
  });

  it("Auto is not written to settings.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-accent-"));
    const file = join(dir, "settings.json");
    await writeFile(
      file,
      `${JSON.stringify({ ...BASE, accentColor: "teal" }, null, 2)}\n`,
      "utf8",
    );
    const patched = await patchWorkspaceSettings(dir, { accentColor: null });
    assert.equal(patched.accentColor, null);
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    assert.ok(!("accentColor" in onDisk));
  });

  it("patchWorkspaceSettings round-trips preset and custom values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jb-accent-"));
    const preset = await patchWorkspaceSettings(dir, { accentColor: "amber" });
    assert.equal(preset.accentColor, "amber");
    const sapphire = await patchWorkspaceSettings(dir, { accentColor: "sapphire" });
    assert.equal(sapphire.accentColor, "sapphire");
    assert.equal((await readWorkspaceSettings(dir))?.accentColor, "sapphire");
    const custom = await patchWorkspaceSettings(dir, { accentColor: "#B695F5" });
    assert.equal(custom.accentColor, "#b695f5");
    const reread = await readWorkspaceSettings(dir);
    assert.equal(reread?.accentColor, "#b695f5");
  });
});
