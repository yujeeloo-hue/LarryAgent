import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("Skipping macOS window capture helper build on non-macOS.");
  process.exit(0);
}

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, "native", "macos-window-capture", "main.swift");
const output = join(root, "build", "helpers", "macos-window-capture");
const targetArch = process.arch === "x64" ? "x86_64" : "arm64";

mkdirSync(dirname(output), { recursive: true });

const result = spawnSync(
  "xcrun",
  [
    "swiftc",
    "-parse-as-library",
    "-swift-version",
    "5",
    "-O",
    "-target",
    `${targetArch}-apple-macosx12.3`,
    "-framework",
    "AppKit",
    "-framework",
    "CoreGraphics",
    "-framework",
    "ImageIO",
    "-framework",
    "UniformTypeIdentifiers",
    source,
    "-o",
    output,
  ],
  { cwd: root, encoding: "utf8" },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`Built macOS window capture helper: ${output}`);
