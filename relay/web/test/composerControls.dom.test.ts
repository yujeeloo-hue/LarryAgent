/**
 * DOM tests: Mac-parity composer controls (web console) — plus menu hosts the
 * attachment entries + permissions radio, the provider menu tops with the
 * Reasoning Effort dial + Infinite switch row, sending rides the round button
 * (stop glyph while running), and New Task mounts the toolbar only when
 * provided (legacy device fallback stays plain).
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
}));

const { buildComposerToolbar } = await import("../src/composerControls.js");
const { buildNewTaskPanel } = await import("../src/render.js");

const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", modelId: "deepseek-v4-flash" },
  { id: "kimi", name: "Kimi", modelId: "kimi-k2" },
];

interface Fired {
  provider?: string;
  providerMenuOpen?: boolean;
  reasoningEffort?: ComposerReasoningEffort;
  infinite?: boolean;
  bypass?: boolean;
  removed?: string;
  sent?: boolean;
  stopped?: boolean;
}

function build(overrides: Record<string, unknown> = {}) {
  const fired: Fired = {};
  const toolbar = buildComposerToolbar(
    {
      providers: PROVIDERS,
      state: { providerId: "deepseek", reasoningEffort: "low", infinite: false, bypass: false },
      bypassAvailable: true,
      ...overrides,
    },
    {
      onPickProvider: (id: string) => void (fired.provider = id),
      onProviderMenuOpen: () => void (fired.providerMenuOpen = true),
      onReasoningEffortSelect: (level: ComposerReasoningEffort) => void (fired.reasoningEffort = level),
      onToggleInfinite: (next: boolean) => void (fired.infinite = next),
      onToggleBypass: (next: boolean) => void (fired.bypass = next),
      onRemoveAttachment: (id: string) => void (fired.removed = id),
      onSend: () => void (fired.sent = true),
      onStop: () => void (fired.stopped = true),
    },
  );
  document.body.append(toolbar.root);
  return { toolbar, fired };
}

function switches(toolbar: ReturnType<typeof buildComposerToolbar>) {
  return [...toolbar.root.querySelectorAll(".composer-switch")] as HTMLButtonElement[];
}

function effortItems(toolbar: ReturnType<typeof buildComposerToolbar>) {
  return [...toolbar.root.querySelectorAll(".effort-seg-item")] as HTMLButtonElement[];
}

test("toolbar shows only [+] / provider pill / send button; extras live in menus", () => {
  const { toolbar } = build();
  assert.ok(toolbar.root.querySelector(".composer-plus-btn"));
  assert.ok(toolbar.root.querySelector(".composer-provider-btn"));
  assert.ok(toolbar.root.querySelector(".composer-send-btn"));
  // No flattened legacy controls survive the Mac parity pass.
  assert.equal(toolbar.root.querySelector(".composer-toggle"), null);
  assert.equal(toolbar.root.querySelector(".composer-icon-btn"), null);

  const plusMenu = toolbar.root.querySelector(".composer-plus-menu") as HTMLElement;
  const labels = [...plusMenu.querySelectorAll(".composer-menu-item")].map((n) => n.textContent);
  assert.deepEqual(labels, ["Image…", "Attachments…", "Safe mode", "Bypass permissions"]);
  // Provider menu carries the two switch rows + the provider list.
  const menu = toolbar.root.querySelector(".composer-provider-menu") as HTMLElement;
  assert.equal(menu.querySelectorAll(".composer-switch-row").length, 2);
  assert.equal(menu.querySelectorAll(".composer-provider-item").length, 2);
});

test("provider pill shows the active label; effort chip follows the dial", () => {
  const { toolbar } = build();
  const label = toolbar.root.querySelector(".composer-provider-label")!;
  assert.equal(label.textContent, "DeepSeek");
  assert.equal(toolbar.root.querySelector(".composer-provider-effort-chip")!.hasAttribute("hidden"), true);

  toolbar.setState({ providerId: "kimi", reasoningEffort: "max" });
  assert.equal(label.textContent, "Kimi");
  const chip = toolbar.root.querySelector(".composer-provider-effort-chip") as HTMLElement;
  assert.equal(chip.hasAttribute("hidden"), false);
  assert.equal(chip.textContent, "MAX");
  assert.ok(chip.classList.contains("is-max"));

  toolbar.setState({ reasoningEffort: "medium" });
  assert.equal(chip.textContent, "MEDIUM");
  assert.equal(chip.classList.contains("is-max"), false);

  toolbar.setState({ reasoningEffort: "low" });
  assert.equal(chip.hasAttribute("hidden"), true);
});

test("setStopMode: stop square, queue-labelled send, plain send (Mac parity)", () => {
  const { toolbar, fired } = build();
  const btn = () => toolbar.root.querySelector(".composer-send-btn") as HTMLButtonElement;

  // Plain send (idle, content).
  toolbar.setStopMode(false);
  assert.equal(btn().classList.contains("is-stop"), false);
  assert.equal(btn().classList.contains("is-queue"), false);
  assert.equal(btn().getAttribute("aria-label"), "Send");

  // Running + content → submit queues: send glyph, queue label, clickable.
  toolbar.setStopMode(false, { steer: true });
  assert.equal(btn().classList.contains("is-stop"), false);
  assert.equal(btn().classList.contains("is-queue"), true);
  assert.equal(btn().getAttribute("aria-label"), "Queue for after this turn");
  toolbar.setSendDisabled(true); // empty composer — still clickable while queueing
  assert.equal(btn().disabled, false);
  btn().click();
  assert.equal(fired.sent, true);
  assert.equal(fired.stopped, undefined);

  // Running + nothing queued → stop square, click cancels.
  toolbar.setStopMode(true);
  assert.equal(btn().classList.contains("is-stop"), true);
  assert.equal(btn().getAttribute("aria-label"), "Stop");
  btn().click();
  assert.equal(fired.stopped, true);

  // Legacy boolean entry stays equivalent to setStopMode(next).
  toolbar.setRunning(true);
  assert.equal(btn().classList.contains("is-stop"), true);
  assert.equal(btn().getAttribute("aria-label"), "Stop");
});

test("setState falls back to the label when the provider is unknown", () => {
  const { toolbar } = build({ providerFallbackLabel: "deleted-model-id" });
  toolbar.setState({ providerId: "gone" });
  assert.equal(toolbar.root.querySelector(".composer-provider-label")!.textContent, "deleted-model-id");
});

test("sendWrap hosts the ring slot and carries is-running for ring recolor", () => {
  const { toolbar } = build();
  assert.ok(toolbar.sendWrap.classList.contains("composer-send-wrap"));
  assert.ok(toolbar.sendWrap.contains(toolbar.root.querySelector(".composer-send-btn")));
  assert.equal(toolbar.sendWrap.classList.contains("is-running"), false);

  toolbar.setStopMode(true);
  assert.ok(toolbar.sendWrap.classList.contains("is-running"));
  // Steer keeps the send glyph — not the stop color story.
  toolbar.setStopMode(false, { steer: true });
  assert.equal(toolbar.sendWrap.classList.contains("is-running"), false);
});

test("permissions radio is exclusive and notifies; hidden when not full-control", () => {
  const { toolbar, fired } = build();
  const full = toolbar.root.querySelector(".composer-menu-item.is-full-option") as HTMLButtonElement;
  const safe = toolbar.root.querySelector(".composer-menu-item.is-safe-option") as HTMLButtonElement;
  assert.ok(safe.classList.contains("is-selected"));
  assert.equal(full.classList.contains("is-selected"), false);

  full.click();
  assert.equal(fired.bypass, true);
  assert.ok(full.classList.contains("is-selected"));
  assert.equal(safe.classList.contains("is-selected"), false);

  safe.click();
  assert.equal(fired.bypass, false);
  assert.ok(safe.classList.contains("is-selected"));

  const limited = build({ bypassAvailable: false });
  const group = limited.toolbar.root.querySelector(".composer-plus-menu-group") as HTMLElement;
  assert.equal(group.hasAttribute("hidden"), true);
});

test("effort dial + Infinite switch flip state, restyle and notify the caller", () => {
  const { toolbar, fired } = build();
  const items = effortItems(toolbar);
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((b) => b.textContent), ["OFF", "LOW", "MED", "HIGH", "MAX"]);
  assert.equal(items[1].getAttribute("aria-checked"), "true"); // low default

  items[4].click(); // MAX
  assert.equal(fired.reasoningEffort, "max");
  assert.equal(items[4].getAttribute("aria-checked"), "true");
  assert.ok(toolbar.root.querySelector(".effort-seg")!.classList.contains("is-gold"));
  assert.equal(items[1].getAttribute("aria-checked"), "false");

  items[0].click(); // OFF
  assert.equal(fired.reasoningEffort, "off");
  assert.equal(toolbar.root.querySelector(".effort-seg")!.classList.contains("is-gold"), false);

  const inf = switches(toolbar)[0]; // only Infinite keeps a switch now
  inf.click();
  assert.equal(fired.infinite, true);
});

test("mobile effort stepper steps levels, clamps at the ends and stays in sync with the dial", () => {
  const { toolbar, fired } = build();
  const minus = toolbar.root.querySelector(".effort-step-minus") as HTMLButtonElement;
  const plus = toolbar.root.querySelector(".effort-step-plus") as HTMLButtonElement;
  const value = toolbar.root.querySelector(".effort-step-value") as HTMLElement;
  const items = effortItems(toolbar);

  // Default LOW: value mirrors the dial, both buttons live.
  assert.equal(value.textContent, "LOW");
  assert.equal(minus.disabled, false);
  assert.equal(plus.disabled, false);

  minus.click(); // → OFF
  assert.equal(fired.reasoningEffort, "off");
  assert.equal(value.textContent, "OFF");
  assert.ok(value.classList.contains("is-off"));
  assert.equal(minus.disabled, true); // clamped
  assert.equal(items[0].getAttribute("aria-checked"), "true"); // dial follows

  minus.click(); // clamped — no event, state unchanged
  assert.equal(fired.reasoningEffort, "off");

  plus.click(); // → LOW
  assert.equal(fired.reasoningEffort, "low");
  assert.equal(value.classList.contains("is-off"), false);

  plus.click(); plus.click(); plus.click(); // → MED → HIGH → MAX
  assert.equal(fired.reasoningEffort, "max");
  assert.equal(value.textContent, "MAX");
  assert.ok(value.classList.contains("is-gold"));
  assert.equal(plus.disabled, true); // clamped
  assert.ok(toolbar.root.querySelector(".effort-seg")!.classList.contains("is-gold"));

  plus.click(); // clamped
  assert.equal(fired.reasoningEffort, "max");

  // Locked session (turn running) locks the stepper (session-pinned control).
  toolbar.setLocked(true);
  assert.equal(minus.disabled, true);
  assert.equal(plus.disabled, true);
  toolbar.setLocked(false);
  assert.equal(minus.disabled, false); // clamps recomputed, not stuck
  assert.equal(plus.disabled, true); // still at MAX

  // External state (device echo) repaints the stepper too.
  toolbar.setState({ reasoningEffort: "medium" });
  assert.equal(value.textContent, "MED");
  assert.equal(plus.disabled, false);
  assert.equal(minus.disabled, false);
});


test("provider menu opens from the pill, lists options and selects", () => {
  const { toolbar, fired } = build();
  const btn = toolbar.root.querySelector(".composer-provider-btn") as HTMLButtonElement;
  btn.click();
  const menu = toolbar.root.querySelector(".composer-provider-menu") as HTMLElement;
  assert.equal(menu.hasAttribute("hidden"), false);
  const items = [...menu.querySelectorAll(".composer-provider-item")] as HTMLElement[];
  assert.equal(items.length, 2);
  assert.ok(items[0].classList.contains("is-active"));
  items[1].click();
  assert.equal(fired.provider, "kimi");
  // Selecting closes the menu.
  assert.equal(menu.classList.contains("is-open"), false);
  // Selection is caller-owned: the pick notifies without self-repainting —
  // the caller echoes setState (New Task locally; conversations reload the
  // session). Self-updating here would desync a failed setSessionProvider.
  assert.equal(toolbar.root.querySelector(".composer-provider-label")!.textContent, "DeepSeek");
  toolbar.setState({ providerId: "kimi" });
  assert.equal(toolbar.root.querySelector(".composer-provider-label")!.textContent, "Kimi");
});

test("setProviders repaints the open menu in place and notifies on menu open", () => {
  const { toolbar, fired } = build();
  const btn = toolbar.root.querySelector(".composer-provider-btn") as HTMLButtonElement;
  btn.click();
  assert.equal(fired.providerMenuOpen, true, "menu open fires the silent re-probe hook");
  const menu = toolbar.root.querySelector(".composer-provider-menu") as HTMLElement;
  assert.equal([...menu.querySelectorAll(".composer-provider-item")].length, 2);
  assert.equal(menu.hasAttribute("hidden"), false);

  // providers_changed landed while the menu is open: the list repaints
  // without closing (deleted Kimi vanishes, GLM appears, pill follows).
  toolbar.setProviders([
    { id: "deepseek", name: "DeepSeek", modelId: "deepseek-v4-flash" },
    { id: "glm", name: "GLM", modelId: "glm-5.3-flash" },
  ]);
  assert.equal(menu.hasAttribute("hidden"), false, "menu stays open across the swap");
  assert.ok(menu.classList.contains("is-open"));
  const names = [...menu.querySelectorAll(".composer-provider-item-name")].map((n) => n.textContent);
  assert.deepEqual(names, ["DeepSeek", "GLM"]);
  // Still-selected provider survives the swap.
  assert.equal(toolbar.root.querySelector(".composer-provider-label")!.textContent, "DeepSeek");

  // Selected provider gone → the pill falls back until the caller echoes a
  // new selection (setState), same contract as onPickProvider.
  toolbar.setProviders([{ id: "glm", name: "GLM", modelId: "glm-5.3-flash" }]);
  assert.equal(toolbar.root.querySelector(".composer-provider-label")!.textContent, "Default");
  toolbar.setState({ providerId: "glm" });
  assert.equal(toolbar.root.querySelector(".composer-provider-label")!.textContent, "GLM");
});

test("plus button opens the menu with the rotating affordance", () => {
  const { toolbar } = build();
  const plus = toolbar.root.querySelector(".composer-plus-btn") as HTMLButtonElement;
  const menu = toolbar.root.querySelector(".composer-plus-menu") as HTMLElement;
  plus.click();
  assert.equal(plus.getAttribute("aria-expanded"), "true");
  assert.ok(plus.classList.contains("is-open"));
  assert.equal(menu.hasAttribute("hidden"), false);
  plus.click();
  assert.equal(plus.getAttribute("aria-expanded"), "false");
});

test("attachment chips render uploading + staged items and remove notifies", () => {
  const { toolbar, fired } = build();
  toolbar.setItems([
    { id: "up:1", name: "shot.png", kind: "image", uploading: true },
    { id: "/tmp/jellybot-remote-uploads/1-notes.txt", name: "notes.txt", kind: "file" },
  ]);
  assert.equal(toolbar.attachments.hasAttribute("hidden"), false);
  const chips = [...toolbar.attachments.querySelectorAll(".composer-attachment-chip")] as HTMLElement[];
  assert.equal(chips.length, 2);
  assert.ok(chips[0].classList.contains("is-uploading"));
  (chips[1].querySelector(".composer-attachment-chip-remove") as HTMLElement).click();
  assert.equal(fired.removed, "/tmp/jellybot-remote-uploads/1-notes.txt");

  toolbar.setItems([]);
  assert.equal(toolbar.attachments.hasAttribute("hidden"), true);
});

test("send button dispatches onSend, then onStop with the square glyph", () => {
  const { toolbar, fired } = build();
  const send = toolbar.root.querySelector(".composer-send-btn") as HTMLButtonElement;
  send.click();
  assert.equal(fired.sent, true);
  assert.equal(fired.stopped, undefined);

  toolbar.setRunning(true);
  assert.ok(send.classList.contains("is-stop"));
  assert.equal(send.getAttribute("aria-label"), "Stop");
  // Icon swap must stay an element node — replaceChildren(string) once
  // rendered the raw SVG source as text.
  assert.equal(send.firstChild?.nodeType, 1);
  assert.ok(send.querySelector("svg rect"));
  send.click();
  assert.equal(fired.stopped, true);

  toolbar.setRunning(false);
  assert.equal(send.classList.contains("is-stop"), false);
  send.click();
  assert.equal(fired.sent, true);
});

test("setSendDisabled only greys the round button", () => {
  const { toolbar } = build();
  const send = toolbar.root.querySelector(".composer-send-btn") as HTMLButtonElement;
  const plus = toolbar.root.querySelector(".composer-plus-btn") as HTMLButtonElement;
  toolbar.setSendDisabled(true);
  assert.ok(send.hasAttribute("disabled"));
  assert.equal(plus.hasAttribute("disabled"), false);

  // Running overrides the empty-text lock — stop must stay clickable.
  toolbar.setRunning(true);
  assert.equal(send.hasAttribute("disabled"), false);
});

test("setLocked spares plus menu + send + provider pill; disables session-pinned controls", () => {
  const { toolbar } = build();
  toolbar.setLocked(true);
  const inf = switches(toolbar)[0];
  assert.ok(inf.hasAttribute("disabled"));
  for (const item of effortItems(toolbar)) {
    assert.ok(item.hasAttribute("disabled"), "effort item should disable");
  }
  // The pill stays clickable while locked — the menu opens read-only.
  const pill = toolbar.root.querySelector(".composer-provider-btn") as HTMLButtonElement;
  assert.equal(pill.hasAttribute("disabled"), false);
  const menu = toolbar.root.querySelector(".composer-provider-menu") as HTMLElement;
  assert.ok(menu.classList.contains("is-locked"));
  assert.equal(menu.querySelector(".composer-provider-locked-hint")!.hasAttribute("hidden"), false);
  for (const item of menu.querySelectorAll(".composer-provider-item")) {
    assert.ok(item.hasAttribute("disabled"), "provider item should disable while locked");
  }
  assert.equal((toolbar.root.querySelector(".composer-plus-btn") as HTMLButtonElement).hasAttribute("disabled"), false);
  assert.equal((toolbar.root.querySelector(".composer-send-btn") as HTMLButtonElement).hasAttribute("disabled"), false);

  toolbar.setLocked(false);
  assert.equal(inf.hasAttribute("disabled"), false);
  for (const item of effortItems(toolbar)) {
    assert.equal(item.hasAttribute("disabled"), false);
  }
  assert.equal(menu.classList.contains("is-locked"), false);
  assert.ok(menu.querySelector(".composer-provider-locked-hint")!.hasAttribute("hidden"));
  for (const item of menu.querySelectorAll(".composer-provider-item")) {
    assert.equal(item.hasAttribute("disabled"), false);
  }

  toolbar.setDisabled(true);
  for (const btn of toolbar.root.querySelectorAll<HTMLButtonElement>("button")) {
    assert.ok(btn.hasAttribute("disabled"), `${btn.className} should disable`);
  }
});

test("New Task panel mounts the Mac-parity card when provided; legacy stays plain", () => {
  const { toolbar } = build();
  const panel = buildNewTaskPanel({
    workspaces: [{ id: "/w/jb", name: "JellyBot", path: "/w/jb" }],
    selectedWorkspaceId: null,
    draft: "",
    heroIconUrl: "favicon.png",
    toolbar,
    onPickWorkspace: () => {},
    onSend: () => {},
  });
  const composer = panel.root.querySelector(".new-task-composer .composer-card")!;
  assert.ok(composer);
  assert.ok(composer.contains(toolbar.attachments));
  assert.ok(composer.contains(toolbar.root));
  // Card order: attachments → textarea → toolbar.
  assert.equal(composer.children[0], toolbar.attachments);
  assert.equal(composer.children[1].tagName, "TEXTAREA");
  assert.equal(composer.children[2], toolbar.root);

  // Legacy device → no toolbar passed → plain composer only.
  const legacy = buildNewTaskPanel({
    workspaces: [{ id: "/w/jb", name: "JellyBot", path: "/w/jb" }],
    selectedWorkspaceId: null,
    draft: "",
    heroIconUrl: "favicon.png",
    onPickWorkspace: () => {},
    onSend: () => {},
  });
  assert.equal(legacy.root.querySelector(".composer-controls"), null);
  assert.equal(legacy.root.querySelector(".composer-attachments"), null);
  assert.ok(legacy.root.querySelector(".composer-row .send-btn"));
});
