import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { patchWorkspaceSettings } from "./patchWorkspaceSettings.js";
import { readWorkspaceSettings } from "./readWorkspaceSettings.js";
import { withSettingsDefaults } from "./types.js";

describe("debug adapter path persistence", () => {
  it("persists a selected lldb-dap path in app settings", async () => {
    const root = mkdtempSync(join(tmpdir(), "debug-adapter-path-"));
    const path = "C:\\LLVM-Larry\\bin\\lldb-dap.exe";

    await patchWorkspaceSettings(root, { debugAdapterPath: path });

    const settings = withSettingsDefaults(await readWorkspaceSettings(root));
    assert.equal(settings.debugAdapterPath, path);
  });
});
