// Live smoke test for the computer-use helper on this machine (macOS or Windows).
// Read-only by default; --live also moves the cursor in place and round-trips a tiny glide.
// Usage: node --import tsx scripts/computer-use-smoke.mts [--live]
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerUseService } from "../src/tools/computerUse/service.ts";
import { WindowAvoidance } from "../src/tools/computerUse/windowAvoidance.ts";
import { ComputerUseWorker, computerUsePlatform } from "../src/tools/computerUse/worker.ts";

const platform = computerUsePlatform();
if (!platform) {
  console.log("Computer use is not supported on this platform.");
  process.exit(0);
}
const live = process.argv.includes("--live");
const worker = new ComputerUseWorker(platform);
const svc = new ComputerUseService(worker, new WindowAvoidance());
const dir = await mkdtemp(join(tmpdir(), "cu-smoke-"));
let failures = 0;

async function step(name: string, run: () => Promise<unknown>): Promise<unknown> {
  const started = Date.now();
  try {
    const result = await run();
    const text = JSON.stringify(result);
    console.log(`ok   ${name} (${Date.now() - started}ms) ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
    return result;
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name} (${Date.now() - started}ms) ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

try {
  await step("system info", () => svc.systemInfo());
  const position = (await step("mouse position", () => svc.position())) as { x: number; y: number } | undefined;
  const shell = platform === "windows" ? "explorer" : "Finder";
  await step(`ui windows ${shell}`, () => svc.uiWindows(shell));
  await step(`ui find ${shell} (buttons)`, () => svc.uiFind({ app: shell, role: "AXButton", timeoutS: 3 }));
  await step("ui dock", () => svc.uiDock());
  await step("ui menubar", () => svc.uiMenubar(undefined, { avoidOcclusion: false }));
  if (position) await step("ui hit_test at cursor", () => svc.uiHitTest(position, { avoidOcclusion: false }));
  await step("mouse click dry run", () => svc.mouseClick({ x: 10, y: 10, button: "left", clicks: 2, modifiers: ["cmd"], holdS: 0.05, dryRun: true }));
  await step("keyboard combo dry run", () => svc.keyCombo({ keys: ["cmd", "s"], dryRun: true }));
  const region = { x: 0, y: 0, width: 800, height: 400 };
  await step("screen capture region", () => svc.capture({ region, path: join(dir, "capture.png") }, { avoidOcclusion: false }));
  const read = (await step("screen read_text", () => svc.readText({ region, lang: "zh-Hans" }, { avoidOcclusion: false }))) as
    | { lines: Array<{ text: string }> }
    | undefined;
  const sample = read?.lines.find((l) => l.text.trim().length >= 3)?.text.trim().slice(0, 6);
  if (sample) await step(`screen find_text "${sample}"`, () => svc.findText({ text: sample, region, index: 0, lang: "zh-Hans" }, { avoidOcclusion: false }));
  if (live && position) {
    await step("live: glide away and back", async () => {
      await svc.mouseMove({ x: position.x + 40, y: position.y + 20, durationS: 0.2 }, { avoidOcclusion: false });
      return svc.mouseMove({ x: position.x, y: position.y, durationS: 0.2 }, { avoidOcclusion: false });
    });
    await step("live: position restored", () => svc.position());
  }
} finally {
  worker.dispose();
  await rm(dir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\nall smoke steps passed" : `\n${failures} smoke step(s) failed`);
process.exit(failures === 0 ? 0 : 1);
