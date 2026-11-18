import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { CocoChatResizeController, cocoChatWidthBounds } from "./CocoChatResizeController.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
const storage = new Map<string, string>();
const observers: Array<{ callback: () => void }> = [];
Object.assign(globalThis, { document: dom.document, window: dom.window,
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  ResizeObserver: class { callback: () => void; constructor(callback: () => void) { this.callback = callback; observers.push(this); } observe() {} disconnect() {} },
});
function event(type: string, values: Record<string, unknown> = {}) {
  return Object.assign(new dom.window.Event(type, { bubbles: true, cancelable: true }), values);
}
function fixture() {
  const root = document.createElement('div'), card = document.createElement('aside'); root.append(card); document.body.append(root);
  let width = 1200;
  root.getBoundingClientRect = () => ({ width } as DOMRect);
  card.getBoundingClientRect = () => {
    const range = cocoChatWidthBounds(width), desired = parseFloat(root.style.getPropertyValue('--coco-chat-width'));
    return { width: Math.max(range.min, Math.min(range.max, desired)) } as DOMRect;
  };
  const controller = new CocoChatResizeController(root, card);
  controller.handle.setPointerCapture = () => {};
  controller.handle.releasePointerCapture = () => {};
  controller.mount();
  return { root, card, controller, resize(value: number) { width = value; observers.at(-1)!.callback(); }, close() { controller.destroy(); root.remove(); } };
}

test('default, keyboard direction, reset and saved width', () => {
  storage.clear(); const f = fixture();
  try {
    assert.equal(f.card.getBoundingClientRect().width, 400);
    f.controller.handle.dispatchEvent(event('keydown', { key: 'ArrowLeft' }));
    assert.equal(f.card.getBoundingClientRect().width, 408);
    f.controller.handle.dispatchEvent(event('keydown', { key: 'ArrowRight', shiftKey: true }));
    assert.equal(f.card.getBoundingClientRect().width, 384);
    const restored = fixture(); try { assert.equal(restored.card.getBoundingClientRect().width, 384); } finally { restored.close(); }
    f.controller.handle.dispatchEvent(event('dblclick'));
    assert.equal(f.card.getBoundingClientRect().width, 400);
    assert.equal(storage.get('jellybot.cocoChatWidth'), '400');
  } finally { f.close(); }
});
test('dragging left widens chat and temporary viewport constraints preserve the preference', () => {
  storage.clear(); const f = fixture();
  try {
    f.controller.handle.dispatchEvent(event('pointerdown', { button: 0, pointerId: 1, clientX: 600 }));
    window.dispatchEvent(event('pointermove', { pointerId: 1, clientX: 500 }));
    assert.equal(f.card.getBoundingClientRect().width, 500);
    window.dispatchEvent(event('pointerup', { pointerId: 1 }));
    assert.equal(storage.get('jellybot.cocoChatWidth'), '500');
    assert.equal(f.root.classList.contains('is-chat-resizing'), false);
    f.resize(600); assert.equal(f.controller.handle.getAttribute('aria-valuenow'), '436');
    assert.equal(f.root.style.getPropertyValue('--coco-chat-width'), '500px');
    f.controller.handle.dispatchEvent(event('keydown', { key: 'ArrowLeft' }));
    assert.equal(storage.get('jellybot.cocoChatWidth'), '500', 'an outward key at the viewport limit must keep the preferred width');
    f.resize(1200); assert.equal(f.controller.handle.getAttribute('aria-valuenow'), '500');
  } finally { f.close(); }
});
test('destroying during a drag removes listeners and dragging state', () => {
  storage.clear(); const f = fixture();
  f.controller.handle.dispatchEvent(event('pointerdown', { button: 0, pointerId: 1, clientX: 600 }));
  f.controller.destroy();
  window.dispatchEvent(event('pointermove', { pointerId: 1, clientX: 400 }));
  assert.equal(f.root.style.getPropertyValue('--coco-chat-width'), '400px');
  assert.equal(f.root.classList.contains('is-chat-resizing'), false);
  f.root.remove();
});
test('bounds fit docked and overlay layouts without overflowing narrow windows', () => {
  assert.deepEqual(cocoChatWidthBounds(1200), { min: 280, max: 720 });
  assert.deepEqual(cocoChatWidthBounds(901), { min: 280, max: 451 });
  assert.deepEqual(cocoChatWidthBounds(390), { min: 220, max: 315 });
  assert.deepEqual(cocoChatWidthBounds(389.99), { min: 220, max: 315 });
  assert.deepEqual(cocoChatWidthBounds(320), { min: 220, max: 245 });
  assert.deepEqual(cocoChatWidthBounds(200), { min: 125, max: 125 });
});
