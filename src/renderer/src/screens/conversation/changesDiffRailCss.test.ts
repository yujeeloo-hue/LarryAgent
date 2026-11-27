import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const css = readFileSync(new URL("./workspace-changes.css", import.meta.url), "utf8");
const rail = readFileSync(new URL("./changesDiffRail.ts", import.meta.url), "utf8");

function rule(selector: string, marker: RegExp): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bodies = [...css.matchAll(new RegExp(`(^|\\n)${escaped}\\s*\\{([\\s\\S]*?)\\}`, "g"))].map(match => match[2] ?? "");
  const found = bodies.find(body => marker.test(body));
  assert.ok(found, `missing ${selector} rule matching ${marker}`);
  return found;
}

test("the rail hugs the code edge and leaves the scrollbar flush with the window", () => {
  const main = rule(".workspace-changes-preview-main", /position:/);
  assert.match(main, /position:\s*relative/);
  const host = rule(".workspace-changes-rail", /position:\s*absolute/);
  // 绝对定位在预览区右缘，右侧偏移由滚动条实测宽度决定（写在行内样式里）
  assert.match(host, /right:\s*0;/);
  assert.match(host, /width:\s*var\(--workspace-changes-rail-w,\s*7px\)/);
  assert.doesNotMatch(host, /flex:/, "the rail must not take a flex column any more");
  // 右侧代码列让出色条那一条位置，内容不会被压住
  assert.match(
    rule(".workspace-changes-preview-body .tool-file-sbs-pane:last-of-type", /padding-right/),
    /padding-right:\s*var\(--workspace-changes-rail-w,\s*7px\)/,
  );
  assert.match(rail, /rail\.style\.right = /);
  assert.match(rail, /scroller\.offsetWidth - scroller\.clientWidth/);
});

test("markers stay weak: 3px marks, no track, no viewport box", () => {
  const mark = rule(".workspace-changes-rail-mark::before", /opacity/);
  assert.match(mark, /width:\s*3px/);
  assert.match(mark, /opacity:\s*0\.72/);
  assert.match(mark, /border-radius:\s*2px/);
  assert.match(rule(".workspace-changes-rail-mark:is(:hover, :focus-visible)::before", /width/), /width:\s*5px/);
  // 去掉看起来像滚动条/轨道的装饰
  assert.doesNotMatch(css, /\.workspace-changes-rail-window\s*\{/);
  const host = rule(".workspace-changes-rail", /position:\s*absolute/);
  assert.doesNotMatch(host, /background:/);
  assert.doesNotMatch(host, /border-left/);
});
