import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  readWorkspaceSettings,
} from "./readWorkspaceSettings.js";
import {
  withSettingsDefaults,
} from "./types.js";
import {
  writeWorkspaceSettingsUnlocked,
} from "./writeWorkspaceSettings.js";

describe("theme persistence round trip", () => {
  it("writes and reads themeId through the real settings file", async () => {
    const root = mkdtempSync(join(tmpdir(), "theme-roundtrip-"));
    const written = await writeWorkspaceSettingsUnlocked(root, {
      providers: [
        {
          id: "default",
          name: "Default",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-4o-mini",
        },
      ],
      activeProviderId: "default",
      themeId: "light",
    });
    assert.equal(written.themeId, "light");

    const read = await readWorkspaceSettings(root);
    assert.equal(read?.themeId, "light");

    const resolved = withSettingsDefaults(read);
    assert.equal(resolved.themeId, "light");
  });
});
