import assert from "node:assert/strict";
import Module from "node:module";
import { before, describe, it } from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const originalLoad = Module._load;
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request.includes("?raw")) return "";
  // Vite `?url` asset imports (e.g. cocoIcon svg urls) exist only after the
  // build pipeline resolves them; stub them like ?raw so node:test can load
  // the module graph. The value is only ever used as an <img src> string.
  if (request.includes("?url")) return request.slice(0, request.indexOf("?url"));
  return originalLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  Event: dom.window.Event,
  requestAnimationFrame: () => 0,
});

type PushedState = {
  phase: "idle" | "queued" | "running" | "done" | "failed";
  step?: "download" | "verify" | "extract" | "smoke" | "install" | "switch" | "units" | "restart";
  progress?: { receivedBytes: number; totalBytes?: number; bytesPerSec?: number; pct?: number };
  version?: string;
  error?: string;
  ts: number;
};
let stateListener: ((state: PushedState) => void) | null = null;
const checkResult = {
  ok: true as const,
  entry: { version: "1.5.11", url: "https://example.invalid/jellybot.zip", sha256: "a".repeat(64) },
  checkedAt: Date.now(),
  currentVersion: "1.5.10",
  upToDate: false,
};
Object.assign(dom.window, {
  jellybot: {
    onRemoteStatus: () => () => {},
    getUpdateState: async () => ({
      currentVersion: "1.5.10",
      platform: "darwin arm64",
      maintenance: null,
      check: null,
    }),
    checkForUpdate: async () => checkResult,
    runUpdate: async () => ({ ok: true }),
    onUpdateState: (listener: (state: PushedState) => void) => {
      stateListener = listener;
      return () => {
        stateListener = null;
      };
    },
  },
});

let SettingView: typeof import("./SettingView.js").SettingView;
before(async () => {
  ({ SettingView } = await import("./SettingView.js"));
});

const flushAsync = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const updateCardOf = (view: InstanceType<typeof SettingView>): HTMLElement =>
  view.root.querySelector<HTMLElement>('.setting-card[data-card="update"]')!;

describe("SettingView Update card", () => {
  it("auto-checks silently and renders the available-release state", async () => {
    const view = new SettingView();
    await flushAsync();
    const card = updateCardOf(view);
    assert.match(card.querySelector(".up-version-line")!.textContent!, /1\.5\.10.*→.*1\.5\.11/);
    assert.match(card.querySelector(".up-note")!.textContent!, /Latest release: 1\.5\.11/);
    const run = card.querySelector<HTMLButtonElement>(".setting-btn-primary")!;
    assert.equal(run.disabled, false);
    assert.equal(run.textContent, "Update");
  });

  it("renders live download progress from the pushed maintenance state", async () => {
    const view = new SettingView();
    await flushAsync();
    stateListener?.({
      phase: "running",
      step: "download",
      progress: { receivedBytes: 66_700_000, totalBytes: 121_300_000, bytesPerSec: 7_500_000, pct: 55 },
      ts: Date.now(),
    });
    const card = updateCardOf(view);
    const chip = card.querySelector<HTMLElement>(".up-chip")!;
    assert.match(chip.className, /is-busy/);
    assert.equal(chip.textContent, "Updating");
    assert.equal(card.querySelector(".up-phase-pct")!.textContent, "55%");
    const bar = card.querySelector<HTMLElement>(".up-progress-bar")!;
    assert.equal(bar.getAttribute("aria-valuenow"), "55");
    assert.match(card.querySelector(".up-progress-meta")!.textContent!, /66\.7 MB \/ 121\.3 MB/);
    const steps = [...card.querySelectorAll(".up-step")].map((el) => el.className.trim());
    assert.deepEqual(steps, ["up-step is-current", "up-step", "up-step"]);
    assert.equal(card.querySelector<HTMLButtonElement>(".setting-btn-primary")!.disabled, true);
  });

  it("patches progress ticks in place without recreating spinners", async () => {
    const view = new SettingView();
    await flushAsync();
    const tick = (receivedBytes: number, pct: number): void => stateListener?.({
      phase: "running",
      step: "download",
      progress: { receivedBytes, totalBytes: 100_000_000, bytesPerSec: 5_000_000, pct },
      ts: Date.now(),
    });
    tick(10_000_000, 10);
    const card = updateCardOf(view);
    const spinners = [...card.querySelectorAll(".spinner")];
    const fill = card.querySelector<HTMLElement>(".up-progress-fill")!;
    assert.ok(spinners.length >= 3);
    tick(42_000_000, 42);
    assert.deepEqual([...card.querySelectorAll(".spinner")], spinners);
    assert.equal(card.querySelector(".up-progress-fill"), fill);
    assert.equal(fill.style.width, "42%");
    assert.equal(card.querySelector(".up-phase-pct")!.textContent, "42%");
    assert.match(card.querySelector(".up-progress-meta")!.textContent!, /42\.0 MB \/ 100\.0 MB/);
    stateListener?.({ phase: "running", step: "verify", ts: Date.now() });
    assert.equal(card.querySelector(".up-progress-fill"), null);
    assert.match(card.querySelector(".up-chip")!.textContent!, /Verifying/);
  });

  it("renders failure with a retry affordance and nothing-changed note", async () => {
    const view = new SettingView();
    await flushAsync();
    stateListener?.({ phase: "failed", error: "download failed: HTTP 502", ts: Date.now() });
    const card = updateCardOf(view);
    assert.match(card.querySelector(".up-chip")!.className, /is-failed/);
    assert.match(card.querySelector(".up-error")!.textContent!, /HTTP 502 — nothing was changed/);
    assert.equal(card.querySelector<HTMLButtonElement>(".setting-btn-primary")!.textContent, "Retry Update");
    assert.equal(card.querySelector<HTMLButtonElement>(".setting-btn-primary")!.disabled, false);
  });

  it("keeps the step track at two steps on Windows channels", async () => {
    const view = new SettingView();
    await flushAsync();
    stateListener?.({ phase: "running", step: "verify", ts: Date.now() });
    const card = updateCardOf(view);
    // The mocked snapshot reports darwin — force the win32 view for this case.
    (view as unknown as { updateSnapshot: { platform: string } }).updateSnapshot.platform = "win32 x64";
    stateListener?.({ phase: "running", step: "verify", ts: Date.now() });
    assert.deepEqual(
      [...card.querySelectorAll(".up-step-label")].map((el) => el.textContent),
      ["Download", "Verify"],
    );
    assert.match([...card.querySelectorAll(".up-step")].map((el) => el.className.trim()).join("|"), /is-done\|up-step is-current/);
  });
});
