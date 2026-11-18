import assert from "node:assert/strict";
import Module from "node:module";
import { before, test } from "node:test";
import { parseHTML } from "linkedom";
import { fsmGraphAuthoringDefinitions } from "../../../../tools/builtin/fsmGraphAuthoring.js";
import { TOOL_UI_DESCRIPTIONS } from "../../../../tools/uiDescriptions.js";

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

const MODEL_ONLY="MODEL_ONLY_SECRET_PROMPT required timeoutMs action=get";
async function mount() {
  Object.assign(window,{jellybot:{
    listTools:async()=>[{category:{id:"filesystem",label:"Filesystem",description:"Work with files."},tools:[{
      name:"read_file",displayName:"Read File",description:MODEL_ONLY,displayDescription:"Read the contents of a file.",
      categoryId:"filesystem",permissionLevel:0,defaultPermissionLevel:0,offered:true,visible:true,
    }]}, {category:{id:"fsm-graph",label:"FSM Graph",description:"Build graph drafts."},tools:fsmGraphAuthoringDefinitions.map(({definition})=>({
      name:definition.name,displayName:definition.name,description:definition.description,
      displayDescription:TOOL_UI_DESCRIPTIONS[definition.name as keyof typeof TOOL_UI_DESCRIPTIONS],
      categoryId:"fsm-graph",permissionLevel:1,defaultPermissionLevel:1,offered:true,visible:true,
    }))}],
    listMcpServers:async()=>[{id:"docs",name:"Docs service",enabled:true,transport:{type:"stdio",command:"docs"},status:"connected",tools:[{
      name:"search_pages",description:MODEL_ONLY,registryName:"mcp__docs__search_pages",permissionLevel:0,defaultPermissionLevel:0,
    }]}],
  }});
  const view=new ToolsView();
  const controller=new ToolsController(view);
  controller.mount();
  await new Promise(resolve=>setImmediate(resolve));
  return {view,controller};
}

test("built-in lists and filtering use the dedicated human summary", async()=>{
  const {view,controller}=await mount();
  try {
    view.root.querySelector<HTMLButtonElement>('[data-category="filesystem"]')!.click();
    assert.equal(view.root.querySelector('#tools-panel-filesystem td.tools-col-desc')?.textContent,"Read the contents of a file.");
    assert.doesNotMatch(view.root.outerHTML,/MODEL_ONLY_SECRET_PROMPT/);
    const input=view.root.querySelector<HTMLInputElement>('.tools-search-input')!;
    input.value="MODEL_ONLY_SECRET_PROMPT";
    input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
    assert.equal(view.root.querySelectorAll('.tools-results tr[data-tool-name]').length,0);
    input.value="contents";
    input.dispatchEvent(new dom.window.Event("input",{bubbles:true}));
    assert.equal(view.root.querySelectorAll('.tools-results tr[data-tool-name="read_file"]').length,1);
  } finally {controller.destroy();}
});

test("MCP display copy and tooltips never expose the provider's model instructions",async()=>{
  const {view,controller}=await mount();
  try {
    assert.equal(view.root.querySelector('#tools-panel-mcp-servers td.tools-col-desc')?.textContent,"Search pages with Docs service.");
    assert.doesNotMatch(view.root.outerHTML,/MODEL_ONLY_SECRET_PROMPT/);
  } finally {controller.destroy();}
});


test("FSM Graph shows concise human descriptions while model instructions stay separate",async()=>{
  const {view,controller}=await mount();
  try {
    view.root.querySelector<HTMLButtonElement>('[data-category="fsm-graph"]')!.click();
    for(const {definition} of fsmGraphAuthoringDefinitions){
      const row=view.root.querySelector<HTMLElement>(`tr[data-tool-name="${definition.name}"]`)!;
      const summary=TOOL_UI_DESCRIPTIONS[definition.name as keyof typeof TOOL_UI_DESCRIPTIONS];
      assert.equal(row.querySelector('.tools-col-desc')!.textContent,summary);
      assert.ok(summary.length<80);
      assert.ok(definition.description.length>500);
      assert.doesNotMatch(row.outerHTML,/expectedRevision|nodeContext resets|paramsSchema/);
    }
  } finally {controller.destroy();}
});
