import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const viewSrc = readFileSync(new URL("./DevToolsView.ts", import.meta.url), "utf8");
const baseCss = readFileSync(new URL("./dev-tools.css", import.meta.url), "utf8");
const devmodeCss = readFileSync(new URL("./dev-tools-devmode.css", import.meta.url), "utf8");

test("each Detail tab pairs with its dedicated colored asset", () => {
  const imports: Array<[string, string]> = [
    ["clockIcon", "../assets/dev-tools/clock.svg"],
    ["fsmIcon", "../assets/dev-tools/fsm.svg"],
    ["logsIcon", "../assets/dev-tools/logs.svg"],
    ["statsIcon", "../assets/dev-tools/stats.svg"],
  ];
  for (const [binding, asset] of imports) {
    assert.match(viewSrc, new RegExp(`import ${binding} from "${asset.replace(/\//g, "\\/")}"`));
  }
  const pairings: Array<[string, string]> = [
    ["timelineTabButton", "clockIcon"],
    ["fsmTabButton", "fsmIcon"],
    ["logsTabButton", "logsIcon"],
    ["toolsTabButton", "statsIcon"],
  ];
  for (const [button, binding] of pairings) {
    assert.match(viewSrc, new RegExp(`\\[this\\.${button}, ${binding}\\]`));
  }
  assert.doesNotMatch(viewSrc, /ChartGantt|Workflow|ScrollText|ChartNoAxesColumn/);
  assert.match(viewSrc, /document\.createElement\("img"\)[\s\S]*?icon\.src = src/);
});

test("colored marks show in both the flat drawer and Dev Mode", () => {
  const baseRule = baseCss.match(/\.dev-tools-tab-icon\s*\{([\s\S]*?)\}/);
  assert.ok(baseRule, "missing base .dev-tools-tab-icon rule");
  assert.match(baseRule[1], /display:\s*block/);
  assert.doesNotMatch(baseRule[1], /display:\s*none/);
  assert.match(baseCss, /\.dev-tools-tab\s*\{[\s\S]*?display:\s*inline-flex/);
  assert.match(baseCss, /\.dev-tools-tab\s*\{[\s\S]*?gap:\s*6px/);
  assert.doesNotMatch(devmodeCss, /\.dev-tools-tab-icon/);
  assert.doesNotMatch(devmodeCss, /--detail-icon-/);
  assert.doesNotMatch(devmodeCss, /\.dev-tools-tab\[data-tab=/);
});

test("dedicated marks follow the coco silhouette recipe", () => {
  const silhouettes: Record<string, RegExp> = {
    clock: /<circle cx="12" cy="12" r="11\.5" fill="white"/,
    fsm: /<rect x="1\.9" y="1\.9" width="8\.4" height="8\.4" rx="2\.6"/,
    logs: /<rect x="2\.3" y="2" width="19\.4" height="20" rx="2\.3" fill="white"/,
    stats: /<rect x="17\.3" y="2\.6" width="4\.7" height="16\.4" rx="1\.7"/,
  };
  for (const [name, silhouette] of Object.entries(silhouettes)) {
    const svg = readFileSync(new URL(`../assets/dev-tools/${name}.svg`, import.meta.url), "utf8");
    assert.match(svg, new RegExp(`linearGradient id="detail-${name}-base"`));
    assert.match(svg, silhouette);
    assert.match(svg, /<path d="M0 15\.2 24 7\.8V24H0Z"[^/]*opacity="\.(55|58|6)"/);
  }
});
