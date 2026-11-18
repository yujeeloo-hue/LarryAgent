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
    electron: join(root, "src/loops/electron-shim.ts"),
  },
  external: [
    "node:*",
    "electron",
    "fsevents",
  ],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  sourcemap: false,
  minify: false,
  logLevel: "info",
});

console.log("[loops-daemon] built:", join(outDir, "loops-daemon.mjs"));
