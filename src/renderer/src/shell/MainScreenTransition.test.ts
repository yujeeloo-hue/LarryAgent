import assert from "node:assert/strict";
import test from "node:test";
import { MainScreenTransition } from "./MainScreenTransition.js";

function harness({ reducedMotion = false, supported = true } = {}) {
  const captures: Array<{ update: () => void; skipCount: number }> = [];
  const scope = {
    ownerDocument: {
      visibilityState: "visible",
      defaultView: { matchMedia: () => ({ matches: reducedMotion }) },
    },
    isConnected: true,
    firstElementChild: {},
    startViewTransition: supported ? (update: () => void) => {
      const capture = { update, skipCount: 0 };
      captures.push(capture);
      let rejectReady: (error: Error) => void = () => {};
      const ready = new Promise<void>((_resolve, reject) => { rejectReady = reject; });
      return {
        ready,
        finished: Promise.resolve(),
        skipTransition() {
          capture.skipCount++;
          rejectReady(new Error("Transition skipped"));
        },
      };
    } : undefined,
  };
  return {
    captures,
    transition: new MainScreenTransition(scope as unknown as HTMLElement),
  };
}

test("interrupted capture commits actions in order without replaying the old route", () => {
  const { transition, captures } = harness();
  const screens: string[] = [];
  transition.run(() => screens.push("tools"));
  assert.deepEqual(screens, []);
  transition.run(() => screens.push("skills"));
  assert.deepEqual(screens, ["tools"]);
  assert.equal(captures[0]!.skipCount, 1);

  captures[1]!.update();
  captures[0]!.update();
  assert.deepEqual(screens, ["tools", "skills"]);
});

test("nested navigation commits as part of the same capture", () => {
  const { transition, captures } = harness();
  const screens: string[] = [];
  transition.run(() => {
    screens.push("dev-mode");
    transition.run(() => screens.push("dev-mode task"));
    assert.deepEqual(screens, ["dev-mode", "dev-mode task"]);
  });
  captures[0]!.update();
  assert.equal(captures.length, 1);
});

test("flush makes the pending screen available to synchronous commands", () => {
  const { transition, captures } = harness();
  let commits = 0;
  transition.run(() => commits++);
  transition.flush();
  assert.equal(commits, 1);
  captures[0]!.update();
  assert.equal(commits, 1);
});

test("reduced motion and missing browser support switch immediately", () => {
  for (const state of [{ reducedMotion: true }, { supported: false }]) {
    const { transition, captures } = harness(state);
    let committed = false;
    transition.run(() => { committed = true; });
    assert.equal(committed, true);
    assert.equal(captures.length, 0);
  }
});
