import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import AdmZip from "adm-zip";
import { LARRY_LLDB_VERSION } from "./adapterProbe.js";
import {
  bundledLldbDapPath,
  ensureBundledLldbDap,
  findBundledLldbDapZip,
} from "./bundledAdapter.js";

describe("bundled Larry lldb-dap", () => {
  it("extracts the committed zip into bin/", () => {
    const root = mkdtempSync(join(tmpdir(), "bundled-lldb-"));
    const dest = join(root, "lldb-dap");
    mkdirSync(dest, { recursive: true });
    const zip = new AdmZip();
    zip.addFile(
      "VERSION.json",
      Buffer.from(JSON.stringify({ version: LARRY_LLDB_VERSION })),
    );
    zip.addFile("bin/lldb-dap.exe", Buffer.from("exe"));
    zip.addFile("bin/lldb-dap", Buffer.from("exe"));
    zip.writeZip(join(dest, `lldb-dap-${LARRY_LLDB_VERSION}-win-x64.zip`));

    assert.ok(
      (findBundledLldbDapZip(root) ?? "").endsWith(
        `lldb-dap-${LARRY_LLDB_VERSION}-win-x64.zip`,
      ),
    );
    const path = ensureBundledLldbDap(root);
    assert.equal(path, bundledLldbDapPath(root));
    assert.equal(ensureBundledLldbDap(root), path);
  });

  it("returns null when the zip is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "bundled-lldb-missing-"));
    mkdirSync(join(root, "lldb-dap"), { recursive: true });
    writeFileSync(join(root, "lldb-dap", "README.md"), "no zip");
    assert.equal(ensureBundledLldbDap(root), null);
  });
});
