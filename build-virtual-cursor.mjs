import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  console.log("Skipping macOS virtual cursor helper build on non-macOS.");
  process.exit(0);
}

const root = dirname(fileURLToPath(import.meta.url));
const nativeDir = join(root, "native", "macos-virtual-cursor");
const helpersDir = join(root, "build", "helpers");
const generatedDir = join(root, "build", "generated", "macos-virtual-cursor");
const output = join(helpersDir, "macos-virtual-cursor");
const targetArch = process.arch === "x64" ? "x86_64" : "arm64";

mkdirSync(helpersDir, { recursive: true });
mkdirSync(generatedDir, { recursive: true });

const tipIcons = {
  "computer-use": join(root, "src", "renderer", "src", "assets", "tools-categories", "computer-use.svg"),
  "tip-confirm": join(nativeDir, "icons", "tip-confirm.svg"),
  "tip-done": join(nativeDir, "icons", "tip-done.svg"),
  "tip-neutral": join(nativeDir, "icons", "tip-neutral.svg"),
};
const tipsHtml = readFileSync(join(nativeDir, "tips.html"), "utf8").replace(/\{\{icon:([a-z-]+)\}\}/g, (_, name) => {
  const file = tipIcons[name];
  if (!file) throw new Error(`Unknown tip icon: ${name}`);
  return `data:image/svg+xml;base64,${readFileSync(file).toString("base64")}`;
});
const tipsPage = Buffer.from(tipsHtml, "utf8").toString("base64");
const tipsSource = join(generatedDir, "TipsPage.swift");
writeFileSync(
  tipsSource,
  `import Foundation\n\nlet tipsPageHTML: String = String(data: Data(base64Encoded: "${tipsPage}") ?? Data(), encoding: .utf8) ?? ""\n`,
);

const result = spawnSync(
  "xcrun",
  [
    "swiftc",
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
    "WebKit",
    join(nativeDir, "SvgPath.swift"),
    join(nativeDir, "Overlay.swift"),
    join(nativeDir, "Tips.swift"),
    tipsSource,
    join(nativeDir, "main.swift"),
    "-o",
    output,
  ],
  { cwd: root, encoding: "utf8" },
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
