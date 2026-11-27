import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("Skipping macOS computer use helper build on non-macOS.");
  process.exit(0);
}

const root = dirname(fileURLToPath(import.meta.url));
const nativeDir = join(root, "native", "macos-computer-use");
const core = join(nativeDir, "Core.swift");
const entry = join(nativeDir, "main.swift");
const bridge = join(nativeDir, "bridge.c");
const helpersDir = join(root, "build", "helpers");
const output = join(helpersDir, "macos-computer-use");
const bridgeObject = join(helpersDir, "macos-computer-use-bridge.o");
const addon = join(helpersDir, "macos-computer-use.node");
const targetArch = process.arch === "x64" ? "x86_64" : "arm64";

mkdirSync(helpersDir, { recursive: true });

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8" });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const swiftArgs = [
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
  "ApplicationServices",
  "-framework",
  "CoreGraphics",
  "-framework",
  "ImageIO",
  "-framework",
  "Vision",
];

run("xcrun", [...swiftArgs, core, entry, "-o", output]);

run("xcrun", ["clang", "-c", bridge, "-I", nativeDir, "-mmacosx-version-min=12.3", "-o", bridgeObject]);

run("xcrun", [
  ...swiftArgs,
  "-emit-library",
  core,
  bridgeObject,
  "-o",
  addon,
  "-Xlinker",
  "-undefined",
  "-Xlinker",
  "dynamic_lookup",
]);

console.log(`Built macOS computer use helper: ${output}`);
console.log(`Built macOS computer use native module: ${addon}`);
