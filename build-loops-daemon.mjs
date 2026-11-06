/**
 * Build the Loops daemon bundle (out/daemon/loops-daemon.mjs).
 *
 * The daemon runs under the app's Electron binary with ELECTRON_RUN_AS_NODE=1,
 * where the real "electron" module is unavailable — it is aliased to a shim
 * (src/loops/electron-shim.ts) that degrades UI-only APIs to no-ops.
 * Packaged via electron-builder extraResources → Contents/Resources/daemon/.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));

if (process.platform === "win32") {
  console.log("Skipping Loops daemon build on Windows (Loops is macOS-only in v1).");
  process.exit(0);
}
const outDir = join(root, "out", "daemon");

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, "src/loops/daemonMain.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: join(outDir, "loops-daemon.mjs"),
  alias: {
    // RUN_AS_NODE resolves "electron" to the binary path string — shim it.
    electron: join(root, "src/loops/electron-shim.ts"),
  },
  external: [
    // Native / runtime-provided modules stay external.
    "node:*",
    "electron",
    "fsevents",
  ],
  banner: {
    // CJS deps (adm-zip etc.) call require() — provide it in ESM output.
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  // node:sqlite, MCP SDK, skills, etc. — keep bundled code identical to app.
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

console.log("[loops-daemon] built:", join(outDir, "loops-daemon.mjs"));
