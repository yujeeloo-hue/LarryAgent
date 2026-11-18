import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { withDemoEscapeBridge } from "./demoEscapeBridge.js";

test("demo Escape bridge keeps the doctype and works before an unclosed trailing comment", () => {
  const source = '<!DOCTYPE html><html><body>你好<!--';
  const result = withDemoEscapeBridge(source);
  assert.ok(result.startsWith("<!DOCTYPE html><script>"));
  assert.ok(result.endsWith("<html><body>你好<!--"));
  assert.ok(withDemoEscapeBridge("<p>Demo</p>").startsWith("<script>"));
});

test("only unhandled Escape requests dismissal from the sandboxed demo", () => {
  let handler: (event: Record<string, unknown>) => void = () => {};
  const posted: unknown[] = [];
  const pending: Array<() => void> = [];
  const script = withDemoEscapeBridge("").match(/<script>([\s\S]*?)<\/script>/)![1]!;
  runInNewContext(script, {
    window: { addEventListener: (type: string, callback: typeof handler) => {
      assert.equal(type, "keydown"); handler = callback;
    } },
    parent: { postMessage: (data: unknown, origin: string) => {
      assert.equal(origin, "*"); posted.push(data);
    } },
    setTimeout: (callback: () => void) => pending.push(callback),
  });
  handler({ key: "Enter" });
  handler({ key: "Escape", defaultPrevented: true });
  handler({ key: "Escape", isComposing: true });
  const handledLater = { key: "Escape", defaultPrevented: false };
  handler(handledLater);
  handledLater.defaultPrevented = true;
  pending.splice(0).forEach(callback => callback());
  assert.equal(posted.length, 0);
  handler({ key: "Escape" });
  pending.splice(0).forEach(callback => callback());
  assert.equal(JSON.stringify(posted), '[{"type":"jellybot-demo-escape"}]');
});
