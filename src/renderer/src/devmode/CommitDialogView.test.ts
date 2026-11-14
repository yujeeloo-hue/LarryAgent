/**
 * DOM tests for the Dev Mode commit dialog.
 *
 * The dialog is the only gate between a right-click and a real commit, so the
 * rules that keep it safe are pinned here: an empty message can never commit,
 * nothing is clickable while git or the model is working, and dismissing it
 * (Escape / backdrop) reports "not committed" rather than silently proceeding.
 */
import { parseHTML } from "linkedom";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Node: dom.Node,
  SVGElement: dom.SVGElement,
});

type ViewModule = typeof import("./CommitDialogView.js");
let CommitDialogView: ViewModule["CommitDialogView"];

before(async () => {
  CommitDialogView = (await import("./CommitDialogView.js")).CommitDialogView;
  // linkedom has no caret API and no KeyboardEvent — fill in what the view uses.
  const probe = dom.document.createElement("textarea") as unknown as {
    setSelectionRange?: () => void;
  };
  const proto = Object.getPrototypeOf(probe) as { setSelectionRange?: () => void };
  proto.setSelectionRange ??= () => {};
});

function keydown(key: string): Event {
  const event = new dom.window.Event("keydown");
  Object.defineProperty(event, "key", { value: key });
  return event;
}

type Calls = {
  generate: number;
  commit: string[];
  cancel: number;
};

function makeDialog(files = ["src/a.ts"]): {
  view: InstanceType<ViewModule["CommitDialogView"]>;
  calls: Calls;
} {
  const calls: Calls = { generate: 0, commit: [], cancel: 0 };
  const view = new CommitDialogView({
    title: 'Commit "a.ts"',
    files,
    handlers: {
      onGenerate: () => {
        calls.generate += 1;
      },
      onCommit: (message) => {
        calls.commit.push(message);
      },
      onCancel: () => {
        calls.cancel += 1;
      },
    },
  });
  return { view, calls };
}

function button(
  view: InstanceType<ViewModule["CommitDialogView"]>,
  selector: string,
): HTMLButtonElement {
  const el = view.root.querySelector(selector);
  assert.ok(el, `missing ${selector}`);
  return el as HTMLButtonElement;
}

function textarea(
  view: InstanceType<ViewModule["CommitDialogView"]>,
): HTMLTextAreaElement {
  const el = view.root.querySelector(".devmode-commit-message");
  assert.ok(el);
  return el as HTMLTextAreaElement;
}

function type(
  view: InstanceType<ViewModule["CommitDialogView"]>,
  text: string,
): void {
  const field = textarea(view);
  field.value = text;
  field.dispatchEvent(new dom.window.Event("input"));
}

describe("CommitDialogView", () => {
  it("keeps Commit disabled until the message has content", () => {
    const { view, calls } = makeDialog();
    const commit = button(view, ".devmode-commit-btn.is-primary");
    assert.equal(commit.disabled, true);

    type(view, "   ");
    assert.equal(commit.disabled, true);

    type(view, "Add the thing");
    assert.equal(commit.disabled, false);

    commit.dispatchEvent(new dom.window.Event("click"));
    assert.deepEqual(calls.commit, ["Add the thing"]);
  });

  it("fills the message from the AI draft", () => {
    const { view, calls } = makeDialog();
    button(view, ".devmode-commit-btn.is-generate").dispatchEvent(
      new dom.window.Event("click"),
    );
    assert.equal(calls.generate, 1);

    view.setMessage("fix: guard the empty pathspec");
    assert.equal(view.getMessage(), "fix: guard the empty pathspec");
    assert.equal(
      button(view, ".devmode-commit-btn.is-primary").disabled,
      false,
    );
  });

  it("locks every action while a commit is in flight", () => {
    const { view, calls } = makeDialog();
    type(view, "Add the thing");
    view.setBusy("commit");

    const commit = button(view, ".devmode-commit-btn.is-primary");
    const generate = button(view, ".devmode-commit-btn.is-generate");
    assert.equal(commit.disabled, true);
    assert.equal(generate.disabled, true);
    assert.equal(textarea(view).readOnly, true);

    commit.dispatchEvent(new dom.window.Event("click"));
    generate.dispatchEvent(new dom.window.Event("click"));
    assert.deepEqual(calls.commit, []);
    assert.equal(calls.generate, 0);

    view.setBusy(null);
    assert.equal(commit.disabled, false);
    assert.equal(textarea(view).readOnly, false);
  });

  it("cancels on Escape and on a backdrop click, not on a panel click", () => {
    const { view, calls } = makeDialog();

    view.root.dispatchEvent(keydown("Escape"));
    assert.equal(calls.cancel, 1);

    const panel = view.root.querySelector(".devmode-commit");
    assert.ok(panel);
    const inside = new dom.window.Event("pointerdown", { bubbles: true });
    panel.dispatchEvent(inside);
    assert.equal(calls.cancel, 1);

    view.root.dispatchEvent(new dom.window.Event("pointerdown"));
    assert.equal(calls.cancel, 2);
  });

  it("lists the committed files and collapses a long list", () => {
    const many = Array.from({ length: 11 }, (_, i) => `src/file-${i}.ts`);
    const { view } = makeDialog(many);
    const rows = [...view.root.querySelectorAll(".devmode-commit-file")];
    assert.equal(rows.length, 9);
    assert.equal(rows.at(-1)?.textContent, "+3 more");
  });
});
