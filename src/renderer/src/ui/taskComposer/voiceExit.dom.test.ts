/**
 * Voice-mode exit enablement — regression repro:
 * toggling back to text mode with an empty composer must disable send.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};
// Vite asset imports (?raw) are not JS — intercept at load time.
const moduleLoad = (Module as unknown as { _load: typeof Module._load })._load;
(Module as unknown as { _load: typeof Module._load })._load = function (
  request: string,
  parent: unknown,
  isMain: boolean,
) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent as Node.Module, isMain);
} as typeof Module._load;

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  SVGElement: dom.SVGElement,
  Node: dom.Node,
  requestAnimationFrame: (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  getComputedStyle: () =>
    ({ getPropertyValue: () => "" }) as unknown as typeof getComputedStyle,
});

type ViewT = typeof import("./TaskComposerView.js")["TaskComposerView"];
let TaskComposerView: ViewT;

test.before(async () => {
  ({ TaskComposerView } = await import("./TaskComposerView.js"));
});

const build = () => {
  const view = new TaskComposerView({
    className: "test",
    onPromptSubmit: () => {},
    onTextInput: () => {},
  } as unknown as ConstructorParameters<ViewT>[0]);
  document.body.append(view.root);
  return view;
};

test("exit voice mode with empty composer disables send", () => {
  const view = build();
  view.setSendEnabled(false); // empty composer baseline
  assert.equal(view.sendButton.disabled, true);

  view.setVoiceMode(true);
  assert.equal(view.sendButton.disabled, false, "mic must be pressable");

  // Even with NO controller syncSendEnabled callback wired (the original
  // bug), the view's content-derived fallback must disable the face.
  view.setVoiceMode(false);
  assert.equal(
    view.sendButton.disabled,
    true,
    "empty composer after exiting voice mode must disable send",
  );
});

test("exit voice mode keeps send enabled when text survived", () => {
  const view = build();
  view.setVoiceMode(true);
  view.setPrompt("hello");
  view.setVoiceMode(false);
  assert.equal(view.sendButton.disabled, false);
});

test("exit voice mode mid-turn keeps the stop face enabled", () => {
  const view = build();
  view.setStopMode(true);
  view.setVoiceMode(true);
  view.setVoiceMode(false);
  assert.equal(view.sendButton.disabled, false, "stop must stay pressable");
});

test("setSendEnabled(false) mid-voice-mode keeps mic pressable", () => {
  const view = build();
  view.setVoiceMode(true);
  view.setSendEnabled(false);
  assert.equal(view.sendButton.disabled, false, "voice mode guards the mic");
});
