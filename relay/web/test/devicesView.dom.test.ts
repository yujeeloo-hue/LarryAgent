/**
 * DOM test: standalone Devices view body — registry list rows, detail
 * panel (identity kv grid, IP history, remote-op stats), and the
 * block/remove/select callbacks (renderDevicesViewBody from render.ts).
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

// Modules touch document/window at call time — install linkedom first.
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  location: { host: "test.local" },
});

const { renderDevicesViewBody, isAgentdDevice, isMaintenanceTickOnly, patchMaintenanceLive, supportsMaintenance, supportsReboot, supportsExec, deviceCocoReady } = await import("../src/render.js");

const NOW = Date.now();

function render(opts: Partial<Parameters<typeof renderDevicesViewBody>[0]> = {}) {
  return renderDevicesViewBody({
    devices: [
      {
        deviceId: "dev-1",
        name: "Studio Mac",
        platform: "darwin arm64",
        version: "0.8.8",
        online: true,
        firstSeen: NOW - 86_400_000,
        lastSeen: NOW - 60_000,
        blocked: false,
        keyName: "Home",
        runningSessions: 2,
        ip: "203.0.113.7",
        ua: "LarryAgent/0.8.8",
        ipHistory: [
          { ip: "203.0.113.7", ts: NOW - 60_000 },
          { ip: "198.51.100.9", ts: NOW - 86_400_000 },
        ],
      },
      {
        deviceId: "dev-2",
        name: "Office Mini",
        platform: "darwin arm64",
        version: "0.8.7",
        online: false,
        firstSeen: NOW - 200_000_000,
        lastSeen: NOW - 7_200_000,
        blocked: true,
        keyName: "Office",
        ipHistory: [],
      },
    ],
    prompts: [
      { ts: NOW - 30_000, deviceId: "dev-1", deviceName: "Studio Mac", keyId: "k1", keyName: "Home", actor: "admin", action: "startTurn", sessionId: "s1", text: "帮我整理今天的会议纪要" },
      { ts: NOW - 10_000, deviceId: "dev-1", deviceName: "Studio Mac", keyId: "k1", keyName: "Home", actor: "admin", action: "enqueuePrompt", sessionId: "s1", text: "补充风险项" },
      { ts: NOW - 5_000, deviceId: "dev-2", deviceName: "Office Mini", keyId: "k2", keyName: "Office", actor: "joji", action: "startTurn", text: "check build" },
    ],
    selectedId: "dev-1",
    onSelect: () => {},
    onBlock: () => {},
    onRemove: () => {},
    ...opts,
  });
}

test("devices view renders registry list with two rows and online count", () => {
  const body = render();
  assert.equal(body.querySelectorAll(".dev-row").length, 2);
  assert.match(body.querySelector(".devices-list-label")!.textContent!, /2 registered · 1 online/);
  assert.ok(body.querySelector(".dev-row.selected")?.textContent?.includes("Studio Mac"));
  assert.match(body.querySelector(".dev-row-sub")!.textContent!, /darwin arm64 · 0\.8\.8 · Home/);
  assert.ok(body.querySelectorAll(".dev-row .dev-dot.online").length === 1, "one online dot");
});

test("devices view detail shows identity, IP history and remote-op stats", () => {
  const body = render();
  const detail = body.querySelector(".dev-detail")!;
  const block = [...detail.querySelectorAll("button")].find((button) => button.textContent === "Block");
  assert.ok(block);
  assert.equal(block.matches(".action-primary, .action-danger"), false);
  assert.match(detail.textContent!, /Studio Mac/);
  assert.match(detail.textContent!, /dev-1/);
  assert.match(detail.textContent!, /203\.0\.113\.7/);
  assert.match(detail.textContent!, /LarryAgent\/0\.8\.8/);
  assert.match(detail.textContent!, /2 sessions running/);
  // IP history: newest first, two rows.
  const histRows = detail.querySelectorAll(".ip-hist-row");
  assert.equal(histRows.length, 2);
  assert.match(histRows[0]!.textContent!, /203\.0\.113\.7/);
  assert.match(histRows[1]!.textContent!, /198\.51\.100\.9/);
  // Stats: only prompts targeting dev-1 count.
  assert.match(detail.textContent!, /2 ops/);
  assert.match(detail.textContent!, /startTurn × 1/);
  assert.match(detail.textContent!, /enqueuePrompt × 1/);
  assert.doesNotMatch(detail.textContent!, /check build/, "other devices' prompts stay out of this panel");
});

test("devices view empty state and no-selection state", () => {  const empty = render({ devices: [], prompts: [], selectedId: null });
  assert.match(empty.textContent!, /No devices registered yet\./);
  assert.match(empty.querySelector(".dev-detail")!.textContent!, /No devices registered yet\./);
});

test("devices view selection and block/remove callbacks fire", () => {
  let selected = "";
  let blocked: { id: string; value: boolean } | null = null;
  let removed: string | null = null;
  const body = render({
    onSelect: (d) => { selected = d.deviceId; },
    onBlock: (d, b) => { blocked = { id: d.deviceId, value: b }; },
    onRemove: (d) => { removed = d.deviceId; },
  });
  const rows = body.querySelectorAll(".dev-row");
  (rows[1] as HTMLElement).click();
  assert.equal(selected, "dev-2");

  const actions = body.querySelectorAll(".dev-detail .card-actions .ghost-btn");
  assert.ok(actions[1]!.classList.contains("action-danger"));
  assert.equal(actions[1]!.classList.contains("action-danger-list"), false, "standalone detail Remove keeps its solid face");
  (actions[0] as HTMLElement).click();
  assert.deepEqual(blocked, { id: "dev-1", value: true });
  (actions[1] as HTMLElement).click();
  assert.equal(removed, "dev-1");
});

test("mobile picker row: shows selected device name and fires onOpenPicker", () => {
  let opened = 0;
  const body = render({ onOpenPicker: () => { opened += 1; } });
  const picker = body.querySelector(".dev-picker") as HTMLButtonElement | null;
  assert.ok(picker, "dev-picker button rendered");
  assert.match(picker.textContent!, /Studio Mac/);
  (picker as HTMLElement).click();
  assert.equal(opened, 1);
});

// ── Maintenance card (agentd remote update/restart) ──────────

test("agentd detection gates remote maintenance: Linux nodes only", () => {
  // The whole Maintenance card is omitted by the controller for anything that
  // is not an agentd (headless Linux) node — desktop clients refuse every
  // maintenance/deviceExec action, so no dead form is shown for them.
  const dev = (platform: string) => ({
    deviceId: "dev-x",
    name: "Node",
    platform,
    version: "1.3.5",
    online: true,
    firstSeen: NOW,
    lastSeen: NOW,
    blocked: false,
  });
  assert.equal(isAgentdDevice(null), false, "no selection → no card");
  for (const platform of ["darwin arm64", "win32 x64", "win32 ia32", ""]) {
    assert.equal(isAgentdDevice(dev(platform)), false, platform);
  }
  for (const platform of ["linux arm64", "linux x64"]) {
    assert.equal(isAgentdDevice(dev(platform)), true, platform);
  }
});

test("capability caps decide the maintenance surface (desktop vs agentd vs legacy)", () => {
  const dev = (platform: string, caps?: string[]) => ({
    deviceId: "dev-c",
    name: "Node",
    platform,
    version: "1.5.2",
    online: true,
    firstSeen: NOW,
    lastSeen: NOW,
    blocked: false,
    ...(caps ? { caps } : {}),
  });

  // Desktop (≥ 1.5.2): update + restart of the app, never host reboot/exec.
  const desktop = dev("darwin arm64", ["maintenance"]);
  assert.equal(supportsMaintenance(desktop), true);
  assert.equal(supportsReboot(desktop), false);
  assert.equal(supportsExec(desktop), false);

  // agentd (≥ 1.5.2): the full surface.
  const agentd = dev("linux arm64", ["maintenance", "reboot", "exec"]);
  assert.equal(supportsMaintenance(agentd), true);
  assert.equal(supportsReboot(agentd), true);
  assert.equal(supportsExec(agentd), true);

  // Devices that predate hello.caps keep the legacy platform fallback.
  assert.equal(supportsMaintenance(dev("linux arm64")), true);
  assert.equal(supportsExec(dev("linux arm64")), true);
  assert.equal(supportsMaintenance(dev("darwin arm64")), false);
  assert.equal(supportsReboot(dev("win32 x64")), false);
  assert.equal(supportsMaintenance(null), false);
});

function maintPanel(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  return {
    calls,
    panel: {
      status: null,
      form: { source: "", sha256: "", force: false, manifestUrl: "https://dl.test/downloads.json" },
      checking: false,
      pending: null,
      logOpen: false,
      onLogToggle: (open: boolean) => { calls.push(`log:${open}`); },
      onFormChange: (patch: { source?: string }) => { calls.push(`form:${JSON.stringify(patch)}`); },
      onRestart: () => { calls.push("restart"); },
      onReboot: () => { calls.push("reboot"); },
      onUpdate: () => { calls.push("update"); },
      onCheckUpdate: () => { calls.push("check"); },
      onRefreshStatus: () => { calls.push("status"); },
      ...overrides,
    },
  };
}

test("maintenance card hidden without the panel, rendered with it", () => {
  const plain = render();
  assert.equal(plain.querySelectorAll(".maint-card").length, 0);

  const { panel } = maintPanel();
  const body = render({ maintenance: panel });
  const card = body.querySelector(".maint-card")!;
  assert.ok(card, "maintenance card rendered");
  assert.match(card.textContent!, /Maintenance/);
  assert.match(card.textContent!, /Idle/, "idle chip without live state");
  assert.equal(card.querySelectorAll(".maint-form input[type=\"text\"]").length, 3);
  assert.ok(card.querySelector(".maint-update-btn"));
});

test("maintenance card hides the host-reboot row for desktop devices", () => {
  const { panel } = maintPanel({
    onReboot: undefined,
    restartHint: "Restart app",
    sourcePlaceholder: "https://…/Larry-Agent-<version>.zip",
  });
  const body = render({ maintenance: panel });
  const card = body.querySelector(".maint-card")!;
  assert.ok(card, "desktop maintenance card rendered");
  assert.match(card.textContent!, /Restart app/);
  assert.doesNotMatch(card.textContent!, /Reboot device/);
  const actions = [...card.querySelectorAll(".maint-actions .ghost-btn")];
  assert.equal(actions.length, 1, "restart only — no reboot button");
});

test("maintenance card fires restart/reboot/update/check/refresh callbacks", () => {
  const { panel, calls } = maintPanel({ form: { source: "/tmp/release.tar.gz", sha256: "", force: false, manifestUrl: "https://dl.test/downloads.json" } });
  const body = render({ maintenance: panel });
  const card = body.querySelector(".maint-card")!;
  const actions = [...card.querySelectorAll<HTMLButtonElement>(".maint-actions .ghost-btn")];
  assert.equal(actions.length, 2);
  actions[0]!.click();
  actions[1]!.click();
  card.querySelector<HTMLButtonElement>(".maint-refresh-btn")!.click();
  card.querySelector<HTMLButtonElement>(".maint-update-btn")!.click();
  const check = [...card.querySelectorAll<HTMLButtonElement>(".maint-update-actions .ghost-btn")]
    .find((b) => b.textContent!.includes("Fetch latest"))!;
  check.click();
  assert.deepEqual(calls, ["restart", "reboot", "status", "update", "check"]);
});

test("exec section: absent without panel.exec, rendered + wired with it", () => {
  const { panel: noExec } = maintPanel();
  assert.equal(render({ maintenance: noExec }).querySelectorAll(".maint-exec").length, 0);

  const calls: string[] = [];
  const { panel } = maintPanel({
    exec: {
      command: "df -h",
      running: false,
      last: {
        command: "echo hi",
        exitCode: 0,
        stdout: "hi\n",
        stderr: "",
        truncated: false,
        timedOut: false,
        durationMs: 12,
        ts: NOW - 5_000,
      },
      onCommandChange: (c: string) => { calls.push(`cmd:${c}`); },
      onRun: () => { calls.push("run"); },
    },
  });
  const body = render({ maintenance: panel });
  const section = body.querySelector(".maint-exec")!;
  assert.ok(section, "exec section rendered");
  const ta = section.querySelector<HTMLTextAreaElement>("textarea.maint-exec-input")!;
  assert.ok(ta, "command textarea rendered");
  assert.equal(ta.value, "df -h", "draft command preserved across renders");
  const run = section.querySelector<HTMLButtonElement>(".maint-exec-run")!;
  assert.ok(run, "Run button rendered");
  assert.equal(run.disabled, false, "enabled: online + non-empty command");
  run.click();
  assert.deepEqual(calls, ["run"], "Run fires onRun (input event not fired by click)");
  const out = section.querySelector(".maint-exec-out")!;
  assert.ok(out, "previous output rendered");
  assert.match(out.textContent!, /\$ echo hi/);
  assert.match(out.textContent!, /exit 0 · 12ms/);
  assert.match(out.textContent!, /hi/);
});

test("exec section: Run disabled on blank command / while running; spinner only while running", () => {
  const { panel: blank } = maintPanel({
    exec: { command: "   ", running: false, last: null, onCommandChange: () => {}, onRun: () => {} },
  });
  const b1 = render({ maintenance: blank });
  assert.equal(b1.querySelector<HTMLButtonElement>(".maint-exec-run")!.disabled, true, "blank command disables Run");
  assert.equal(b1.querySelectorAll(".maint-exec .spinner").length, 0, "no spinner when idle");

  const { panel: running } = maintPanel({
    exec: { command: "df -h", running: true, last: null, onCommandChange: () => {}, onRun: () => {} },
  });
  const b2 = render({ maintenance: running });
  const run2 = b2.querySelector<HTMLButtonElement>(".maint-exec-run")!;
  assert.equal(run2.disabled, true, "running disables Run (single-flight)");
  assert.equal(b2.querySelectorAll(".maint-exec .spinner").length, 1, "spinner while running");
  assert.equal(b2.querySelectorAll(".maint-exec-out").length, 0, "no output block before the first run");
});

test("exec section: typing into an empty draft enables Run live (no re-render path)", () => {
  // Regression: the button's disabled state was only computed at render time,
  // so an initially empty draft left Run greyed out forever — onCommandChange
  // updates state without re-rendering (cursor jump), and nothing synced the
  // button. The input handler must flip it itself.
  const calls: string[] = [];
  const { panel } = maintPanel({
    exec: {
      command: "",
      running: false,
      last: null,
      onCommandChange: (c: string) => { calls.push(`cmd:${c}`); },
      onRun: () => { calls.push("run"); },
    },
  });
  const body = render({ maintenance: panel });
  const ta = body.querySelector<HTMLTextAreaElement>("textarea.maint-exec-input")!;
  const run = body.querySelector<HTMLButtonElement>(".maint-exec-run")!;
  assert.equal(run.disabled, true, "empty draft starts disabled");

  ta.value = "df -h";
  ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.deepEqual(calls, ["cmd:df -h"], "onCommandChange fired with the draft");
  assert.equal(run.disabled, false, "typing enables Run without a re-render");

  run.click();
  assert.deepEqual(calls, ["cmd:df -h", "run"], "enabled Run fires onRun");

  ta.value = "   ";
  ta.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(run.disabled, true, "clearing the draft disables Run again");
});

test("Fetch latest spinner only renders while checking (idle shows no spinner)", () => {
  const findCheck = (body: HTMLElement) =>
    [...body.querySelectorAll<HTMLButtonElement>(".maint-update-actions .ghost-btn")]
      .find((b) => b.textContent!.includes("Fetch latest"))!;

  const idle = render({ maintenance: maintPanel().panel });
  const idleBtn = findCheck(idle);
  assert.equal(idleBtn.querySelector(".spinner"), null, "no spinner when idle");
  assert.equal(idleBtn.disabled, false);

  const busy = render({ maintenance: maintPanel({ checking: true }).panel });
  const busyBtn = findCheck(busy);
  assert.ok(busyBtn.querySelector(".spinner.maint-spinner"), "spinner while checking");
  assert.equal(busyBtn.disabled, true, "button locked while checking");
});

test("automatic release checks show quiet loading, result and retry information in the card", () => {
  const loading = render({ maintenance: maintPanel({ checking: true }).panel });
  assert.match(loading.querySelector(".maint-check-note")!.textContent!, /Checking latest release/);
  assert.equal(loading.querySelector(".maint-check-note")!.getAttribute("role"), "status");
  const checked = render({ maintenance: maintPanel({ releaseCheck: {
    checkedAt: NOW, error: null, version: "1.5.8", keptSelection: true,
  } }).panel });
  assert.match(checked.querySelector(".maint-check-note")!.textContent!, /Latest release: 1.5.8/);
  assert.match(checked.querySelector(".maint-check-note")!.textContent!, /selected package was kept/);
  const failed = render({ maintenance: maintPanel({ releaseCheck: {
    checkedAt: null, error: "device offline", version: null, keptSelection: false,
  } }).panel });
  assert.match(failed.querySelector(".maint-check-note")!.textContent!, /Could not check latest: device offline/);
  assert.equal(failed.querySelector<HTMLButtonElement>(".maint-check-btn")!.disabled, false);
});

test("maintenance card shows live phase, log tail and error; busy locks actions", () => {
  const { panel } = maintPanel();
  const body = render({
    maintenance: panel,
    devices: [
      {
        deviceId: "dev-1",
        name: "Pi Node",
        platform: "linux arm64",
        version: "1.3.1",
        online: true,
        firstSeen: NOW - 1000,
        lastSeen: NOW,
        blocked: false,
        maintenance: {
          phase: "running",
          id: "u1",
          source: "https://dl.test/jellybot-agentd-1.3.1-linux-arm64.tar.gz",
          logTail: "Downloading https://dl.test/…",
          ts: NOW - 2000,
        },
      },
    ],
    selectedId: "dev-1",
  });
  const card = body.querySelector(".maint-card")!;
  assert.match(card.querySelector(".maint-chip")!.textContent!, /Updating/);
  assert.match(card.textContent!, /jellybot-agentd-1\.3\.1-linux-arm64\.tar\.gz/);
  assert.match(card.querySelector(".maint-log")!.textContent!, /Downloading/);
  const actions = [...card.querySelectorAll<HTMLButtonElement>("button")];
  const locked = actions.filter((b) => b.hasAttribute("disabled"));
  assert.ok(locked.length > 0, "busy phase disables the action buttons");
  assert.ok(locked.some((b) => b.textContent!.includes("Restart")));
  assert.ok(locked.some((b) => b.classList.contains("maint-update-btn")));

  // failed phase surfaces the error line.
  const failed = render({
    maintenance: panel,
    devices: [
      {
        deviceId: "dev-1",
        name: "Pi Node",
        platform: "linux arm64",
        version: "1.3.1",
        online: true,
        firstSeen: NOW - 1000,
        lastSeen: NOW,
        blocked: false,
        maintenance: { phase: "failed", error: "sha256 mismatch", ts: NOW - 1000 },
      },
    ],
    selectedId: "dev-1",
  });
  assert.match(failed.querySelector(".maint-card")!.textContent!, /sha256 mismatch/);
  assert.match(failed.querySelector(".maint-chip")!.textContent!, /Failed/);

  const stalled = render({
    maintenance: panel,
    devices: [
      {
        deviceId: "dev-1",
        name: "Pi Node",
        platform: "linux arm64",
        version: "1.3.1",
        online: true,
        firstSeen: NOW - 1000,
        lastSeen: NOW,
        blocked: false,
        maintenance: { phase: "running", ts: NOW - 120_000 },
      },
    ],
    selectedId: "dev-1",
  });
  const stalledCard = stalled.querySelector(".maint-card")!;
  assert.match(stalledCard.textContent!, /actions unlocked/);
  const restart = [...stalledCard.querySelectorAll<HTMLButtonElement>("button")]
    .find((b) => b.textContent!.includes("Restart"))!;
  assert.equal(restart.hasAttribute("disabled"), false);
});

test("fine-grained progress: step track buckets, download bar, chip percentage", () => {
  const { panel } = maintPanel();
  const agentd = (maintenance: Record<string, unknown>) => render({
    maintenance: panel,
    devices: [
      {
        deviceId: "dev-1",
        name: "Pi Node",
        platform: "linux arm64",
        version: "1.4.1",
        online: true,
        firstSeen: NOW - 1000,
        lastSeen: NOW,
        blocked: false,
        maintenance,
      },
    ],
    selectedId: "dev-1",
  });

  // Downloading with a known size: chip %, current bucket, determinate bar,
  // raw log demoted behind a collapsed toggle.
  const downloading = agentd({
    phase: "running",
    id: "u2",
    source: "https://dl.test/jellybot-agentd-1.4.1-linux-arm64.tar.gz",
    step: "download",
    progress: { receivedBytes: 17_825_792, totalBytes: 42_991_619, bytesPerSec: 1_200_000, pct: 41 },
    logTail: "Downloading https://dl.test/…",
    ts: NOW - 1000,
  });
  const card = downloading.querySelector(".maint-card")!;
  assert.match(card.querySelector(".maint-chip")!.textContent!, /Updating · 41%/);
  const steps = [...card.querySelectorAll(".maint-step")];
  assert.equal(steps.length, 5, "five UI buckets");
  assert.ok(steps[0]!.classList.contains("is-current"), "Download is current");
  assert.ok(!steps[1]!.classList.contains("is-current"));
  assert.equal((card.querySelector(".maint-progress-fill")! as HTMLElement).style.width, "41%");
  assert.match(card.querySelector(".maint-progress-label")!.textContent!, /17\.0 MB \/ 41\.0 MB/);
  assert.equal(card.querySelector(".maint-percent")!.textContent, "41%");
  assert.equal(card.querySelector('[role="progressbar"]')!.getAttribute("aria-valuenow"), "41");
  assert.match(card.querySelector(".maint-progress-rate")!.textContent!, /1\.1 MB\/s/);
  const logwrap = card.querySelector(".maint-logwrap")!;
  assert.ok(logwrap, "log wrapped in a details toggle");
  assert.equal(logwrap.hasAttribute("open"), false, "collapsed by default");
  assert.match(card.querySelector(".maint-log")!.textContent!, /Downloading/);

  // No Content-Length: indeterminate runner + rate only.
  const indet = agentd({
    phase: "running",
    step: "download",
    progress: { receivedBytes: 17_825_792, bytesPerSec: 1_258_291 },
    ts: NOW - 1000,
  });
  assert.ok(indet.querySelector(".maint-progress-fill")!.classList.contains("is-indet"));
  assert.match(indet.querySelector(".maint-progress-label")!.textContent!, /17\.0 MB/);
  assert.match(indet.querySelector(".maint-progress-rate")!.textContent!, /1\.2 MB\/s/);
  assert.equal(indet.querySelector('[role="progressbar"]')!.hasAttribute("aria-valuenow"), false);

  // smoke lands in the Extract bucket; restart shows four done + one current.
  const smoking = agentd({ phase: "running", step: "smoke", ts: NOW - 1000 });
  const smokeSteps = [...smoking.querySelectorAll(".maint-step")];
  assert.ok(smokeSteps[2]!.classList.contains("is-current"), "smoke buckets into Extract");

  const restarting = agentd({ phase: "running", step: "restart", ts: NOW - 1000 });
  const restartSteps = [...restarting.querySelectorAll(".maint-step")];
  assert.ok(restartSteps.slice(0, 4).every((s) => s.classList.contains("is-done")));
  assert.ok(restartSteps[4]!.classList.contains("is-current"));
  assert.equal(restarting.querySelector(".maint-progress"), null, "no byte bar after the download step");
  assert.match(restarting.querySelector(".maint-live .cell-sub")!.textContent!, /Restarting/);

  // Failure marks its bucket red; done paints everything green + version.
  const failed = agentd({ phase: "failed", step: "download", error: "download stalled — no bytes for 30s", ts: NOW - 1000 });
  assert.ok(failed.querySelector(".maint-step")!.classList.contains("is-failed"));
  assert.match(failed.querySelector(".maint-error")!.textContent!, /download stalled/);

  const done = agentd({ phase: "done", version: "1.4.1", step: "restart", ts: NOW - 60_000 });
  assert.match(done.querySelector(".maint-chip")!.textContent!, /Done · 1\.4\.1/);
  assert.ok([...done.querySelectorAll(".maint-step")].every((s) => s.classList.contains("is-done")));
});

test("legacy agentd (no step field) keeps the plain log view; reboot says Rebooting", () => {
  const { panel } = maintPanel();
  const agentd = (maintenance: Record<string, unknown>) => render({
    maintenance: panel,
    devices: [
      {
        deviceId: "dev-1",
        name: "Pi Node",
        platform: "linux arm64",
        version: "1.3.1",
        online: true,
        firstSeen: NOW - 1000,
        lastSeen: NOW,
        blocked: false,
        maintenance,
      },
    ],
    selectedId: "dev-1",
  });

  const legacy = agentd({
    phase: "running",
    source: "https://dl.test/jellybot-agentd-1.4.1-linux-arm64.tar.gz",
    logTail: "Downloading https://dl.test/…",
    ts: NOW - 1000,
  });
  const card = legacy.querySelector(".maint-card")!;
  assert.equal(card.querySelector(".maint-steps"), null, "no step track without step field");
  assert.equal(card.querySelector(".maint-logwrap"), null, "legacy log stays a visible pre");
  assert.match(card.querySelector(".maint-chip")!.textContent!, /Updating/);
  assert.ok(card.querySelector(".maint-log"), "log pre still rendered");

  const rebooting = agentd({ phase: "running", source: "reboot", ts: NOW - 1000 });
  assert.match(rebooting.querySelector(".maint-chip")!.textContent!, /Rebooting/);
  assert.equal(rebooting.querySelector(".maint-steps"), null, "no track for reboots");
});

test("progress ticks patch the maintenance card in place (no view rebuild)", () => {
  const { panel } = maintPanel();
  const mkDevice = (maintenance: Record<string, unknown>) => ({
    deviceId: "dev-1",
    name: "Pi Node",
    platform: "linux arm64",
    version: "1.4.1",
    online: true,
    firstSeen: NOW - 1000,
    lastSeen: NOW,
    blocked: false,
    maintenance,
  });
  const downloading = {
    phase: "running",
    id: "u9",
    source: "https://dl.test/jellybot-agentd-1.4.1-linux-arm64.tar.gz",
    step: "download",
    progress: { receivedBytes: 17_825_792, totalBytes: 42_991_619, pct: 41 },
    logTail: "Downloading https://dl.test/…",
    ts: NOW - 1000,
  };
  const body = render({
    maintenance: panel,
    devices: [mkDevice(downloading)],
    selectedId: "dev-1",
  });

  // Markers OUTSIDE the live zone: the form input and the card body itself.
  const sourceInput = [...body.querySelectorAll<HTMLInputElement>(".maint-form input[type=\"text\"]")][0]!;
  sourceInput.value = "https://dl.test/edited.tar.gz";
  const cardBody = body.querySelector(".maint-card .card-body")!;
  const zonesBefore = body.querySelectorAll(".maint-live-zone").length;
  assert.equal(zonesBefore, 1, "live block lives in a single patchable zone");

  // The gate: a broadcast differing only by volatile fields is tick-only.
  const tick = mkDevice({ ...downloading, progress: { receivedBytes: 33_030_240, totalBytes: 42_991_619, pct: 77 }, ts: NOW - 500 });
  assert.equal(isMaintenanceTickOnly([mkDevice(downloading)], [tick]), true);
  // Structural changes are NOT tick-only.
  assert.equal(
    isMaintenanceTickOnly([mkDevice(downloading)], [mkDevice({ ...downloading, step: "verify" })]),
    false,
    "step advance re-renders",
  );
  assert.equal(
    isMaintenanceTickOnly([mkDevice(downloading)], [mkDevice({ ...downloading, phase: "failed" })]),
    false,
    "phase change re-renders",
  );
  assert.equal(
    isMaintenanceTickOnly([mkDevice(downloading)], [{ ...mkDevice(downloading), online: false }]),
    false,
    "online flip re-renders",
  );
  assert.equal(
    isMaintenanceTickOnly([mkDevice(downloading)], [mkDevice(downloading), mkDevice(downloading)]),
    false,
    "device-set change re-renders",
  );

  // The patch: chip + zone refresh, everything else keeps node identity.
  // (linkedom keeps body detached, so identity is asserted via querySelector
  // equality rather than isConnected.)
  // Animation continuity: spinners, the step track, the progress fill and
  // the log <pre> must survive as the SAME nodes — rebuilding them every
  // tick restarts their CSS animations (the stutter this patch fixes).
  const chipSpinnerBefore = body.querySelector(".maint-chip .spinner");
  const stepSpinnerBefore = body.querySelector(".maint-step.is-current .spinner");
  const trackBefore = body.querySelector(".maint-steps");
  const fillBefore = body.querySelector(".maint-progress-fill");
  const zoneBefore = body.querySelector(".maint-live-zone");
  const logBefore = body.querySelector(".maint-log");
  assert.ok(chipSpinnerBefore && stepSpinnerBefore, "both spinners rendered pre-patch");
  const ok = patchMaintenanceLive(body, tick.maintenance as never, panel);
  assert.equal(ok, true);
  assert.equal(body.querySelector(".maint-chip .spinner"), chipSpinnerBefore, "chip spinner node kept — rotation never restarts");
  assert.equal(body.querySelector(".maint-step.is-current .spinner"), stepSpinnerBefore, "step spinner node kept — rotation never restarts");
  assert.equal(body.querySelector(".maint-steps"), trackBefore, "step track node kept");
  assert.equal(body.querySelector(".maint-progress-fill"), fillBefore, "progress fill node kept — width transition glides");
  assert.equal(body.querySelector(".maint-live-zone"), zoneBefore, "zone node kept");
  assert.equal(body.querySelector(".maint-log"), logBefore, "log pre node kept");
  assert.match(body.querySelector(".maint-log")!.textContent!, /Downloading/, "log text refreshed in place");
  assert.equal(body.querySelector(".maint-form input"), sourceInput, "same node, not a rebuild");
  assert.equal(sourceInput.value, "https://dl.test/edited.tar.gz", "in-flight typing survives");
  assert.equal(body.querySelector(".maint-card .card-body"), cardBody, "card body untouched");
  assert.equal(body.querySelectorAll(".maint-live-zone").length, 1, "exactly one zone after patch");
  assert.match(body.querySelector(".maint-chip")!.textContent!, /Updating · 77%/);
  assert.equal((body.querySelector(".maint-progress-fill")! as HTMLElement).style.width, "77%");
  assert.match(body.querySelector(".maint-progress-label")!.textContent!, /31\.5 MB \/ 41\.0 MB/);
  assert.equal(body.querySelector(".maint-percent")!.textContent, "77%");

  // Shape change (error appears) → the zone is rebuilt wholesale.
  const zoneNodeBefore = body.querySelector(".maint-live-zone");
  patchMaintenanceLive(body, { ...tick.maintenance, error: "checksum mismatch", ts: NOW - 400 } as never, panel);
  assert.notEqual(body.querySelector(".maint-live-zone"), zoneNodeBefore, "error arrival replaces the zone");
  assert.match(body.querySelector(".maint-error")!.textContent!, /checksum mismatch/);

  // Both legacy and idle cards keep a patchable zone; a missing card refuses it.
  const legacyBody = render({
    maintenance: panel,
    devices: [{
      deviceId: "dev-1",
      name: "Pi Node",
      platform: "linux arm64",
      version: "1.3.1",
      online: true,
      firstSeen: NOW - 1000,
      lastSeen: NOW,
      blocked: false,
      maintenance: { phase: "running", logTail: "Downloading …", ts: NOW },
    }],
    selectedId: "dev-1",
  });
  assert.ok(patchMaintenanceLive(legacyBody, { phase: "running", logTail: "Downloading …", ts: NOW }, panel) === true, "legacy card still patches (zone exists)");
  assert.equal(patchMaintenanceLive(render({ maintenance: panel }), null, panel), true, "idle card keeps its live zone");
  const plain = render();
  assert.equal(patchMaintenanceLive(plain, null, panel), false, "no card on screen → caller falls back to full render");
});

test("update and progress precede collapsed settings and device controls", () => {
  const { panel } = maintPanel({
    openSections: { command: true },
    exec: { command: "df -h", running: false, last: null, onCommandChange: () => {}, onRun: () => {} },
  });
  const body = render({ maintenance: panel });
  const children = [...body.querySelector(".maint-body")!.children];
  assert.ok(children[0]!.classList.contains("maint-update-section"));
  assert.ok(children[0]!.querySelector(".maint-update-actions"));
  assert.ok(children[0]!.querySelector(".maint-live-zone"));
  assert.ok(children[1]!.classList.contains("maint-package"));
  assert.ok(children[2]!.classList.contains("maint-device-controls"));
  assert.equal(body.querySelector(".maint-package")!.hasAttribute("open"), false);
  assert.equal(body.querySelector(".maint-command")!.hasAttribute("open"), true);
  assert.equal(body.querySelector(".maint-installation")!.hasAttribute("open"), false);
});

test("package edits clear manifest metadata and validate checksums without rebuilding inputs", () => {
  const calls: unknown[] = [];
  const { panel } = maintPanel({
    form: { source: "https://dl.test/custom.tar.gz", sha256: "a".repeat(64), force: false, manifestUrl: "https://dl.test/downloads.json", version: "2.0.0" },
    onFormChange: (patch: unknown) => calls.push(patch),
  });
  const body = render({ maintenance: panel });
  assert.match(body.querySelector(".maint-version-line")!.textContent!, /0\.8\.8→2\.0\.0/);
  const source = body.querySelector<HTMLInputElement>('[data-maint-field="source"]')!;
  const sha = body.querySelector<HTMLInputElement>('[data-maint-field="sha256"]')!;
  const update = body.querySelector<HTMLButtonElement>(".maint-update-btn")!;
  assert.equal(update.disabled, false);
  sha.value = "invalid";
  sha.dispatchEvent(new dom.window.Event("input"));
  assert.equal(update.disabled, true);
  source.value = "/tmp/custom.tar.gz";
  source.dispatchEvent(new dom.window.Event("input"));
  assert.equal(update.disabled, false, "device paths do not require a URL checksum");
  assert.equal(body.querySelector(".maint-version-line")!.textContent, "0.8.8", "unknown package version is not invented");
  assert.deepEqual(calls.at(-1), { source: "/tmp/custom.tar.gz", version: undefined });
  assert.equal(body.querySelector('[data-maint-field="source"]'), source, "typing keeps the same input node");
  source.value = "";
  source.dispatchEvent(new dom.window.Event("input"));
  assert.equal(update.disabled, true);
});

test("known same-version releases require force and explain how to enable reinstall", () => {
  const { panel } = maintPanel({ form: {
    source: "https://dl.test/jellybot-agentd-0.8.8-linux-arm64.tar.gz", sha256: "a".repeat(64), force: false, manifestUrl: "https://dl.test/downloads.json",
  } });
  const body = render({ maintenance: panel });
  const update = body.querySelector<HTMLButtonElement>(".maint-update-btn")!;
  assert.equal(update.textContent, "Reinstall");
  assert.equal(update.disabled, true);
  assert.equal(body.querySelector<HTMLElement>(".maint-reinstall-hint")!.hidden, false);
  const force = body.querySelector<HTMLInputElement>('[data-maint-field="force"]')!;
  force.checked = true;
  force.dispatchEvent(new dom.window.Event("change"));
  assert.equal(update.disabled, false);
  assert.equal(body.querySelector<HTMLElement>(".maint-reinstall-hint")!.hidden, true);
});

test("each platform's package renders its own version (desktop filenames included)", () => {
  // Windows device (1.5.2) with the win setup in the win draft → 1.5.2 → 1.5.3.
  const win = maintPanel({ form: {
    source: "https://dl.test/Larry-Agent-1.5.3-win-x64-setup.exe",
    sha256: "a".repeat(64), force: false, manifestUrl: "https://dl.test/downloads.json", channel: "win",
  } });
  const winBody = render({
    maintenance: win.panel,
    devices: [{
      deviceId: "dev-1", name: "Desktop PC", platform: "win32 x64", version: "1.5.2",
      online: true, firstSeen: NOW, lastSeen: NOW, blocked: false,
    }],
    selectedId: "dev-1",
  });
  assert.match(winBody.querySelector(".maint-version-line")!.textContent!, /1\.5\.2→1\.5\.3/);
  assert.equal(winBody.querySelector<HTMLButtonElement>(".maint-update-btn")!.textContent, "Update");
  assert.equal(winBody.querySelector<HTMLButtonElement>(".maint-update-btn")!.disabled, false);

  // macOS device (1.5.2) on its own zip: same version → Reinstall, and the win
  // 1.5.3 above never leaks into this card.
  const mac = maintPanel({ form: {
    source: "https://dl.test/Larry-Agent-1.5.2-mac-arm64.zip",
    sha256: "b".repeat(64), force: false, manifestUrl: "https://dl.test/downloads.json", channel: "mac",
  } });
  const macBody = render({
    maintenance: mac.panel,
    devices: [{
      deviceId: "dev-1", name: "Studio Mac", platform: "darwin arm64", version: "1.5.2",
      online: true, firstSeen: NOW, lastSeen: NOW, blocked: false,
    }],
    selectedId: "dev-1",
  });
  assert.equal(macBody.querySelector(".maint-version-line")!.textContent, "1.5.2");
  assert.equal(macBody.querySelector<HTMLButtonElement>(".maint-update-btn")!.textContent, "Reinstall");
  assert.equal(macBody.querySelector<HTMLButtonElement>(".maint-update-btn")!.disabled, true);
});

test("Fetch latest names the release channel it reads", () => {
  const { panel } = maintPanel({ form: {
    source: "", sha256: "", force: false, manifestUrl: "https://dl.test/downloads.json", channel: "agentd",
  } });
  const body = render({ maintenance: panel });
  const check = [...body.querySelectorAll<HTMLButtonElement>(".maint-update-actions .ghost-btn")]
    .find((b) => b.textContent!.includes("Fetch latest"))!;
  assert.match(check.title, /agentd entry of the manifest/);
});

test("fold callbacks retain user choices and ignore toggles on removed cards", () => {
  const calls: unknown[] = [];
  const { panel } = maintPanel({ onSectionToggle: (...args: unknown[]) => calls.push(args) });
  const body = render({ maintenance: panel });
  dom.document.body.append(body);
  const details = body.querySelector<HTMLDetailsElement>(".maint-package")!;
  details.open = true;
  details.dispatchEvent(new dom.window.Event("toggle"));
  assert.deepEqual(calls, [["package", true]]);
  body.remove();
  details.open = false;
  details.dispatchEvent(new dom.window.Event("toggle"));
  assert.equal(calls.length, 1, "a removed subtree cannot overwrite the next render's state");
});

test("an active update reports its own target instead of an older form draft", () => {
  const { panel } = maintPanel({ form: {
    source: "https://dl.test/custom.tar.gz", version: "1.3.0", sha256: "a".repeat(64), force: false, manifestUrl: "https://dl.test/downloads.json",
  } });
  const device = {
    deviceId: "dev-1", name: "Pi Node", platform: "linux arm64", version: "1.4.0", online: true,
    firstSeen: NOW, lastSeen: NOW, blocked: false,
  };
  const body = render({ maintenance: panel, devices: [{ ...device, maintenance: {
    phase: "running", source: "https://dl.test/jellybot-agentd-1.4.1-linux-arm64.tar.gz", step: "download", ts: NOW,
  } }] });
  assert.equal(body.querySelector(".maint-version-line")!.textContent, "1.4.0→1.4.1");
  assert.match(body.querySelector(".maint-version-meta")!.textContent!, /Updating release/);
  assert.equal(body.querySelector<HTMLInputElement>('[data-maint-field="source"]')!.value, panel.form.source);
  const rebooted = render({ maintenance: panel, devices: [{ ...device, maintenance: { phase: "done", source: "reboot", ts: NOW } }] });
  assert.equal(rebooted.querySelector(".maint-phase")!.textContent, "Reboot complete");
});

test("maintenance card renders deviceStatus snapshot rows and offline note", () => {
  const { panel } = maintPanel({
    status: {
      supervised: true,
      installDir: "/opt/jellybot-agentd",
      current: "/opt/jellybot-agentd/1.3.1",
      previous: "/opt/jellybot-agentd/1.3.0",
      releases: ["1.3.0", "1.3.1"],
    },
  });
  const online = render({ maintenance: panel });
  const kv = online.querySelector(".maint-kv")!;
  assert.match(kv.textContent!, /systemd/);
  assert.match(kv.textContent!, /1\.3\.1/);
  assert.match(kv.textContent!, /1\.3\.0/);

  const offline = render({
    maintenance: panel,
    devices: [
      {
        deviceId: "dev-9",
        name: "Offline Pi",
        platform: "linux arm64",
        version: "1.3.1",
        online: false,
        firstSeen: NOW - 1000,
        lastSeen: NOW,
        blocked: false,
      },
    ],
    selectedId: "dev-9",
  });
  assert.match(offline.querySelector(".maint-card")!.textContent!, /Device offline/);
});

test("CoCo entry: device card action, gated on the coco cap and online state", () => {
  const base = {
    deviceId: "dev-c",
    name: "CoCo Mac",
    platform: "darwin arm64",
    version: "1.6.2",
    online: true,
    firstSeen: NOW - 5000,
    lastSeen: NOW,
    blocked: false,
    caps: ["coco", "maintenance"],
  };

  const opened: string[] = [];
  const on = render({ devices: [base], selectedId: "dev-c", onOpenCoco: (d) => opened.push(d.deviceId) });
  const btn = on.querySelector<HTMLElement>(".coco-entry-btn");
  assert.ok(btn, "phones reach the workspace from the device's own card");
  assert.equal(btn!.getAttribute("aria-label"), "Open CoCo on CoCo Mac");
  assert.ok(btn!.querySelector("svg"), "carries the CoCo mark (not a generic icon)");
  assert.match(btn!.textContent!, /CoCo/);
  btn!.dispatchEvent(new dom.window.Event("click"));
  assert.deepEqual(opened, ["dev-c"]);

  // A dead button is worse than none: no cap → no entry.
  const noCap = render({ devices: [{ ...base, caps: [] }], selectedId: "dev-c", onOpenCoco: () => assert.fail("must not fire") });
  assert.equal(noCap.querySelector(".coco-entry-btn"), null, "cap-less device has no entry");
  const offline = render({ devices: [{ ...base, online: false }], selectedId: "dev-c", onOpenCoco: () => assert.fail("must not fire") });
  assert.equal(offline.querySelector(".coco-entry-btn"), null, "offline device has no entry");
  // Without the callback the card is unchanged (desktop keeps the sidebar row).
  const noCallback = render({ devices: [base], selectedId: "dev-c" });
  assert.equal(noCallback.querySelector(".coco-entry-btn"), null);

  // The gate itself is exported and shared with the sidebar entry.
  assert.equal(deviceCocoReady(base), true);
  assert.equal(deviceCocoReady({ ...base, online: false }), false);
  assert.equal(deviceCocoReady({ ...base, caps: undefined }), false);
});
