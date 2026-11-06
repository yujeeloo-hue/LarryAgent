import assert from "node:assert/strict";
import Module from "node:module";
import { before, test } from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return originalLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis,{ document:dom.document, window:dom.window, Event:dom.window.Event, requestAnimationFrame:()=>0 });
if (!globalThis.CSS?.escape) Object.assign(globalThis,{CSS:{escape:(value:string)=>value.replace(/["\\\]]/g,"\\$&")}});

let ToolsView: typeof import("./ToolsView.js").ToolsView;
let ToolsController: typeof import("./ToolsController.js").ToolsController;
before(async()=>{
  ({ToolsView}=await import("./ToolsView.js"));
  ({ToolsController}=await import("./ToolsController.js"));
});

type NcHandler = (payload: { eventName: string; params: unknown }) => void;

/** Mount with a counting bridge mock; exposes the captured nc:event handler. */
async function mountCounting() {
  let listCalls = 0;
  let ncHandler: NcHandler | undefined;
  let unsubscribed = false;
  Object.assign(window,{jellybot:{
    listTools:async()=>{ listCalls+=1; return []; },
    listMcpServers:async()=>[],
    onNotificationCenterEvent:(handler:NcHandler)=>{
      ncHandler=handler;
      return ()=>{ unsubscribed=true; };
    },
  }});
  const view=new ToolsView();
  const controller=new ToolsController(view);
  controller.mount();
  await new Promise(resolve=>setImmediate(resolve));
  return {
    controller,
    calls:()=>listCalls,
    handler:():NcHandler=>{
      if(!ncHandler) throw new Error("nc:event handler was not registered");
      return ncHandler;
    },
    unsubscribed:()=>unsubscribed,
  };
}

test("bridged events trigger one debounced reload; unrelated events do not",{timeout:5000},async()=>{
  const h=await mountCounting();
  try {
    assert.equal(h.calls(),1); // initial mount reload
    h.handler()({eventName:"tools/config_changed",params:{section:"mcpServers"}});
    h.handler()({eventName:"mcp/server_status",params:{serverId:"x",status:"connected"}});
    await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(h.calls(),1); // still inside the debounce window
    await new Promise(resolve=>setTimeout(resolve,340));
    assert.equal(h.calls(),2); // burst coalesced into one reload
    h.handler()({eventName:"something/else",params:{}});
    await new Promise(resolve=>setTimeout(resolve,400));
    assert.equal(h.calls(),2); // unrelated eventName ignored
  } finally { h.controller.destroy(); }
});

test("destroy() unsubscribes and cancels the pending debounced reload",{timeout:5000},async()=>{
  const h=await mountCounting();
  h.handler()({eventName:"tools/config_changed",params:{section:"skills"}});
  h.controller.destroy();
  assert.ok(h.unsubscribed());
  await new Promise(resolve=>setTimeout(resolve,400));
  assert.equal(h.calls(),1); // no reload after destroy
});
