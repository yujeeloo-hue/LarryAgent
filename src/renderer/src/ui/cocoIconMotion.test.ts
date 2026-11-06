import assert from "node:assert/strict";
import test from "node:test";
import { COCO_RESET_MS, CocoIconMotionClock } from "./cocoIconMotion.js";

const idle = { global: false, work: false, chat: false };
const work = { global: true, work: true, chat: false };

test("stopping returns to the default phase and a later run starts at zero", () => {
  const clock = new CocoIconMotionClock();
  clock.setRunning(work, 1000);
  clock.setRunning(idle, 3456);
  assert.equal(clock.elapsed("work", 3456), 2456);
  assert.equal(clock.elapsed("work", 3456 + COCO_RESET_MS), 0);
  clock.setRunning(work, 10_000);
  assert.equal(clock.elapsed("work", 10_000), 0);
  assert.equal(clock.elapsed("work", 11_000), 1000);
});

test("polling neither restarts running time nor prolongs the return", () => {
  const clock = new CocoIconMotionClock();
  clock.setRunning(work, 500);
  clock.setRunning(work, 2500);
  assert.equal(clock.elapsed("work", 3500), 3000);
  clock.setRunning(idle, 4500);
  clock.setRunning(idle, 4800);
  assert.equal(clock.elapsed("work", 4500 + COCO_RESET_MS), 0);
});

test("a rapid restart and another stop keep the original return deadline", () => {
  const clock = new CocoIconMotionClock();
  clock.setRunning(work, 1000);
  clock.setRunning(idle, 2000);
  clock.setRunning(work, 2100);
  clock.setRunning(idle, 2200);
  assert.equal(clock.elapsed("work", 2500), 0);
  clock.setRunning(work, 2600);
  assert.equal(clock.elapsed("work", 2700), 100);
});

test("chat and work return independently while navigation follows either activity", () => {
  const clock = new CocoIconMotionClock();
  clock.setRunning(work, 1000);
  clock.setRunning({ ...work, chat: true }, 2000);
  clock.setRunning({ global: true, work: false, chat: true }, 3000);
  assert.equal(clock.elapsed("global", 5000), 4000);
  assert.equal(clock.elapsed("work", 5000), 0);
  assert.equal(clock.elapsed("chat", 5000), 3000);
});

test("replacement icons use the browser animation frame clock", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  const timeline = { currentTime: 1000 };
  Object.defineProperty(globalThis, "document", { configurable: true, value: { timeline } });
  try {
    const clock = new CocoIconMotionClock();
    clock.setRunning(work);
    timeline.currentTime = 1875;
    assert.equal(clock.elapsed("work"), 875);
    clock.setRunning(idle);
    timeline.currentTime += COCO_RESET_MS;
    assert.equal(clock.elapsed("work"), 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

function fixture() {
  const animations: Array<{ frames: Keyframe[]; timing: KeyframeAnimationOptions; startTime: number | null; onfinish: (() => void) | null; cancel(): void }> = [];
  const animate = (frames: Keyframe[], timing: KeyframeAnimationOptions) => {
    const animation = { frames, timing, startTime: null as number | null, onfinish: null as (() => void) | null, cancel() {} };
    animations.push(animation); return animation;
  };
  const spin = { currentTime: 0 };
  const color = { currentTime: 0 };
  const shape = { getAnimations: () => [spin], animate, transform: "matrix(0, 1, -1, 0, 0, 0)" };
  const base = { animate, opacity: "0" };
  const layer = { animate, opacity: "0.4" };
  const classes = new Set<string>();
  const styles = new Map<string, string>();
  const element = { isConnected: true, querySelector: () => shape, querySelectorAll: () => [base, layer],
    getAnimations: () => [spin, color], classList: { add: (value: string) => classes.add(value), remove: (value: string) => classes.delete(value) },
    style: { setProperty: (key: string, value: string) => styles.set(key, value) } };
  return { element: element as unknown as HTMLElement, spin, color, shape, animations, classes, styles };
}

function withComputedStyle(run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "getComputedStyle");
  Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (element: unknown) => element });
  try { run(); } finally {
    if (previous) Object.defineProperty(globalThis, "getComputedStyle", previous);
    else Reflect.deleteProperty(globalThis, "getComputedStyle");
  }
}

test("return starts at the displayed frame and finishes at the default palette and angle", () => withComputedStyle(() => {
  const clock = new CocoIconMotionClock(), icon = fixture();
  clock.setRunning(work, 1000);
  clock.track(icon.element, "work", 0);
  icon.spin.currentTime = icon.color.currentTime = 475;
  assert.equal(clock.elapsed("work", 1500), 475);
  clock.setRunning(idle, 1500);
  assert.deepEqual(icon.animations[0]!.frames, [{ transform: icon.shape.transform }, { transform: "rotate(0deg)" }]);
  assert.deepEqual(icon.animations[1]!.frames, [{ opacity: "0" }, { opacity: "1" }]);
  assert.deepEqual(icon.animations[2]!.frames, [{ opacity: "0.4" }, { opacity: "0" }]);
  assert.equal(icon.animations[0]!.timing.duration, COCO_RESET_MS);
  assert.ok(icon.classes.has("coco-icon--resetting"));
  clock.setRunning(work, 1600);
  assert.equal(icon.animations.length, 3, "a restart waits for the existing return");
  icon.animations[0]!.onfinish!();
  assert.equal(icon.spin.currentTime, 0);
  assert.equal(icon.color.currentTime, 0);
  assert.equal(icon.styles.get("--coco-spin-delay"), "0s");
  assert.equal(icon.styles.get("--coco-motion-delay"), "0s");
  assert.ok(!icon.classes.has("coco-icon--resetting"));
  icon.spin.currentTime = 100;
  assert.equal(clock.elapsed("work", 2100), 100);
}));

test("a remount joins the same return and an old completion cannot finish a newer return", () => withComputedStyle(() => {
  const clock = new CocoIconMotionClock(), first = fixture(), replacement = fixture();
  clock.setRunning(work, 1000);
  clock.track(first.element, "work", 0);
  first.spin.currentTime = 475;
  clock.setRunning(idle, 1500);
  const oldFinish = first.animations[0]!.onfinish!;
  Object.assign(first.element, { isConnected: false });
  clock.track(replacement.element, "work", 475);
  assert.equal(replacement.animations[0]!.startTime, 1500);
  assert.deepEqual(replacement.animations[0]!.frames, first.animations[0]!.frames);
  oldFinish();
  clock.setRunning(work, 2500);
  replacement.spin.currentTime = 200;
  clock.setRunning(idle, 2700);
  oldFinish();
  assert.ok(replacement.classes.has("coco-icon--resetting"));
  assert.equal(clock.elapsed("work", 3200), 0);
}));

test("persistent navigation icons reset animations recreated after a layout move", () => withComputedStyle(() => {
  const clock = new CocoIconMotionClock(), icon = fixture();
  clock.setRunning(work, 1000);
  clock.track(icon.element, "global", 0);
  // Moving the existing sidebar through a detached layout creates new CSS
  // animations on the same elements. The original animation objects are stale.
  const spin = { currentTime: 845 }, color = { currentTime: 2860 };
  Object.assign(icon.element, { getAnimations: () => [spin, color] });
  Object.assign(icon.shape, { getAnimations: () => [spin] });
  clock.setRunning(idle, 4000);
  const returning = icon.animations.map(animation => Object.assign(animation, { currentTime: COCO_RESET_MS }));
  Object.assign(icon.element, { getAnimations: () => [spin, color, ...returning] });
  icon.animations[0]!.onfinish!();
  assert.equal(spin.currentTime, 0);
  assert.equal(color.currentTime, 0);
  assert.ok(returning.every(animation => animation.currentTime === COCO_RESET_MS), "the temporary return is canceled without being rewound");
  assert.ok(!icon.classes.has("coco-icon--resetting"));
}));

test("navigation icons tracked while hidden reset animations created when shown", () => withComputedStyle(() => {
  const clock = new CocoIconMotionClock(), icon = fixture();
  Object.assign(icon.element, { getAnimations: () => [] });
  Object.assign(icon.shape, { getAnimations: () => [] });
  clock.track(icon.element, "global", 0);
  const spin = { currentTime: 1000 }, color = { currentTime: 3600 };
  Object.assign(icon.element, { getAnimations: () => [spin, color] });
  Object.assign(icon.shape, { getAnimations: () => [spin] });
  clock.setRunning(work, 1000);
  clock.setRunning(idle, 4600);
  icon.animations[0]!.onfinish!();
  assert.equal(spin.currentTime, 0);
  assert.equal(color.currentTime, 0);
}));
