/**
 * Conversation footer sync buttons. Update appears only when the SVN
 * working copy is behind HEAD. Pull appears only when its Git target is
 * behind upstream. Detecting a repo, or a failed check, does not show them.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  CSS: { escape: (value: string) => value },
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
});

type Bar = import("./ConversationGitBarView.js").ConversationGitBarView;
let ConversationGitBarView: new () => Bar;

test.before(async () => {
  ({ ConversationGitBarView } = await import("./ConversationGitBarView.js"));
});
test.afterEach(() => document.body.replaceChildren());

const REPO_STATS = {
  isRepo: true,
  insertions: 0,
  deletions: 0,
  dirtyFileCount: 0,
  aheadCount: 0,
  behindCount: 0,
};

function mount(): {
  bar: Bar;
  pullButton: HTMLButtonElement;
  updateButton: HTMLButtonElement;
} {
  const bar = new ConversationGitBarView();
  document.body.append(bar.root);
  const pullButton = bar.root.querySelector<HTMLButtonElement>(
    ".conversation-git-pull-btn",
  )!;
  const updateButton = bar.root.querySelector<HTMLButtonElement>(
    ".conversation-git-update-btn",
  )!;
  assert.ok(pullButton, "pull button carries the hook class");
  assert.ok(updateButton, "update button carries the hook class");
  return { bar, pullButton, updateButton };
}

function click(button: HTMLButtonElement): void {
  // linkedom has no MouseEvent constructor — the click handlers here never
  // read mouse properties, so a plain bubbling Event is enough.
  button.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
}

test("Pull on a Git workspace shows only when behind, then routes onPull", () => {
  const { bar, pullButton, updateButton } = mount();
  bar.setSyncTargets({ svn: false, git: "workspace" });
  bar.setStats({ ...REPO_STATS, behindCount: 0 });
  assert.equal(pullButton.hidden, true, "nothing to pull → hidden");
  assert.equal(updateButton.hidden, true);
  assert.equal(bar.root.hidden, true, "no stats/push/subagents → bar hidden");

  bar.setStats({ ...REPO_STATS, behindCount: 2 });
  assert.equal(pullButton.hidden, false);
  assert.equal(bar.root.hidden, false, "bar stays alive via the Pull button");
  assert.match(pullButton.title, /2 commit\(s\) behind/);
  let pulls = 0;
  bar.onPull = () => {
    pulls += 1;
  };
  click(pullButton);
  assert.equal(pulls, 1);
});

test("Update and Pull stay hidden until each side is actually behind", () => {
  const { bar, pullButton, updateButton } = mount();
  bar.setStats({ ...REPO_STATS, isRepo: true, behindCount: 3 });
  bar.setPullUncertain(true);
  assert.equal(pullButton.hidden, true, "isRepo alone is not a Git target");
  assert.equal(updateButton.hidden, true);

  bar.setSyncTargets({ svn: true, git: "none" });
  assert.equal(updateButton.hidden, true, "SVN with nothing incoming stays hidden");
  bar.setSvnBehind(true);
  assert.equal(updateButton.hidden, false);
  assert.equal(pullButton.hidden, true, "SVN-only keeps Pull hidden");
  assert.match(updateButton.textContent ?? "", /Update/);
  let updates = 0;
  bar.onUpdate = () => {
    updates += 1;
  };
  click(updateButton);
  assert.equal(updates, 1);
  bar.setSvnBehind(false);
  assert.equal(updateButton.hidden, true, "catching up hides Update");

  bar.setSyncTargets({ svn: true, git: "external" });
  bar.setSvnBehind(false);
  bar.setGitBehind(0);
  assert.equal(updateButton.hidden, true);
  assert.equal(pullButton.hidden, true, "engine up to date hides Pull");
  bar.setSvnBehind(true);
  bar.setGitBehind(4);
  assert.equal(updateButton.hidden, false);
  assert.equal(pullButton.hidden, false);
  assert.match(pullButton.title, /engine — 4 commit/);
});

test("a failed upstream check does not reveal Pull", () => {
  const { bar, pullButton } = mount();
  bar.setSyncTargets({ svn: false, git: "workspace" });
  bar.setStats({ ...REPO_STATS, behindCount: 0 });
  bar.setPullUncertain(true);
  assert.equal(pullButton.hidden, true);
  bar.setSyncTargets({ svn: true, git: "external" });
  bar.setPullUncertain(true);
  bar.setGitBehind(0);
  assert.equal(pullButton.hidden, true, "SVN beside Git still needs commits to pull");
});

test("setPullBusy locks the button and flips the label", () => {
  const { bar, pullButton } = mount();
  bar.setSyncTargets({ svn: false, git: "workspace" });
  bar.setStats({ ...REPO_STATS, behindCount: 1 });
  let pulls = 0;
  bar.onPull = () => {
    pulls += 1;
  };
  bar.setPullBusy(true);
  assert.equal(pullButton.disabled, true);
  assert.match(pullButton.textContent ?? "", /Pulling…/);
  click(pullButton);
  assert.equal(pulls, 0, "busy click is dropped");
  bar.setPullBusy(false);
  assert.equal(pullButton.disabled, false);
  assert.match(pullButton.textContent ?? "", /Pull/);
  click(pullButton);
  assert.equal(pulls, 1, "click routes again after busy clears");
});
