import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

function mobileRanges(): Array<[number, number]> {
  const marker = "@media (max-width: 768px) {";
  const ranges: Array<[number, number]> = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(marker, from);
    if (start === -1) break;
    let depth = 0;
    let end = -1;
    for (let i = css.indexOf("{", start); i < css.length; i += 1) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.notEqual(end, -1, "unbalanced mobile block");
    ranges.push([start, end]);
    from = end + 1;
  }
  assert.ok(ranges.length > 0, "mobile block present");
  return ranges;
}

function assertMobileOnly(rule: string, message: string): void {
  const at = css.indexOf(rule);
  assert.notEqual(at, -1, message);
  assert.equal(css.indexOf(rule, at + 1), -1, `${message} (declared twice)`);
  const ranges = mobileRanges();
  assert.ok(
    ranges.some(([start, end]) => at > start && at < end),
    `${message} (must stay inside @media (max-width: 768px) so the wide layout keeps its topbar)`,
  );
}

test("standalone pages (Devices / Manage / CoCo) hide the app topbar", () => {
  assert.match(
    css,
    /\.app:has\(> \.layout\.is-standalone\) > \.topbar \{ display: none; \}/,
    "is-standalone is the single source that hides the topbar",
  );
  assert.match(css, /\.layout\.is-standalone \.sidebar,\s*\n\.layout\.is-standalone \.session-col \{ display: none; \}/);
});

test("phone: a pushed conversation hides the topbar and keeps the notch inset", () => {
  assertMobileOnly(
    '.app:has(> .layout[data-view="conv"]) > .topbar { display: none; }',
    "conv view drops the topbar on phones only",
  );
  assertMobileOnly(
    ".layout[data-view=\"conv\"] .conv-head { padding-top: calc(6px + var(--safe-area-top)); }",
    "conv head takes over the safe-area inset the topbar used to paint",
  );
  assertMobileOnly(
    ".layout.is-standalone .view-head { padding-top: calc(10px + var(--safe-area-top)); }",
    "standalone heads take over the safe-area inset too",
  );
});

test("home / new task / memory keep the topbar", () => {
  const hiders = [...css.matchAll(/\.app:has\(> \.layout(\.is-standalone|\[data-view="conv"\])\) > \.topbar \{ display: none; \}/g)]
    .map((match) => match[1]);
  assert.deepEqual(hiders.sort(), ['.is-standalone', '[data-view="conv"]'], "exactly two chrome-less states");
  assert.doesNotMatch(css, /data-view="newTask"[^{]*\.topbar/);
  assert.doesNotMatch(css, /#memoryView[^{]*\.topbar/);
});

test("page heads carry the connection badge the topbar used to show", () => {
  assert.match(css, /\.head-conn \{ display: inline-flex; align-items: center; gap: 8px; flex: none; font-size: 12px; color: var\(--fg-muted\); font-variant-numeric: tabular-nums; \}/);
});

test("phone: every view inside .main is re-enabled by data-view (incl. CoCo)", () => {
  const shown = css.match(/\.layout\[data-view="conv"\] \.main,[\s\S]*?\{\s*\n\s*display: flex;/);
  assert.ok(shown, "pushed-view allowlist present");
  const values = [...shown![0].matchAll(/data-view="([^"]+)"\] \.main/g)].map((m) => m[1]);
  assert.deepEqual(values.sort(), ["coco", "conv", "devices", "manage", "memory", "newTask"], "every viewMode that mounts inside .main");

  const calmEnd = css.indexOf(".main { transition: none; }");
  assert.notEqual(calmEnd, -1, "reduced-motion reset present");
  const calm = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce) {", calmEnd), calmEnd);
  const calmValues = [...calm.matchAll(/data-view="([^"]+)"\] \.main/g)].map((m) => m[1]);
  assert.deepEqual(calmValues.sort(), values.sort(), "reduced-motion list mirrors the allowlist");
});

test("CoCo entry on the device card is phone-only chrome", () => {
  assert.match(css, /\.coco-entry-btn \{ display: none; \}/, "desktop keeps the sidebar row as the entry");
  assertMobileOnly(".coco-entry-btn { display: inline-flex; }", "phones get the card entry");
});

test("CoCo tile in the home selector row is phone-only and hides when gated", () => {
  assertMobileOnly(
    ".m-coco-btn {\n    position: relative; display: inline-flex; align-items: center; justify-content: center;\n    width: 44px; min-width: 44px; height: 44px; padding: 0;",
    "home CoCo tile lives in the ≤768px block only",
  );
  assertMobileOnly(".m-coco-btn[hidden] { display: none; }", "gated tile must actually disappear");
  assert.match(css, /\.m-coco-btn \{/, "tile styled");
});

test("home selector row wires the CoCo tile left of refresh", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  assert.match(
    main,
    /const mobileHead = el\("div", \{ class: "mobile-home-head" \}, devSelectBtn, projSelectBtn, mCocoBtn, mRefreshBtn\);/,
    "CoCo tile sits between the project pill and refresh",
  );
  assert.match(main, /class: "m-coco-btn", type: "button",[\s\S]{0,120}?hidden: true/, "tile renders hidden until a device qualifies");
  assert.match(main, /refs\.mCocoBtn\.hidden = !cocoEntry\.visible;/, "visibility follows cocoEntryState");
  assert.match(main, /cocoEntryState\(devices, device\?\.deviceId \?\? null\)/, "gate + target resolved once per render");
});
