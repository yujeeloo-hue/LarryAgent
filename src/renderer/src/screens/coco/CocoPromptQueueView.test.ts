import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { CocoPromptQueueView } from "./CocoPromptQueueView.js";
import type { PromptQueueHandlers, PromptQueueItem } from "../conversation/PromptQueueView.js";

const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document, window });
Object.assign(window.HTMLElement.prototype, {
  showPopover() { this.setAttribute("data-open", "true"); },
  hidePopover() { this.removeAttribute("data-open"); },
  getBoundingClientRect() { return { left:100, right:240, top:100, bottom:124, width:144, height:100 }; },
});
Object.assign(window.HTMLTextAreaElement.prototype, {
  setCustomValidity(message: string) { this.dataset.validationMessage = message; },
  reportValidity() { return !this.dataset.validationMessage; },
});

const item = (id: string, mode: PromptQueueItem["mode"] = "deferred"): PromptQueueItem => ({ id, text:`Message ${id}`, mode, attachments:[] });
function fixture(items = [item("a"), item("b")]) {
  const calls: unknown[][] = [];
  const handlers: PromptQueueHandlers = {
    onRemove:id => calls.push(["remove",id]),
    onUpdateText:(id,text) => calls.push(["edit",id,text]),
    onMoveToFront:id => calls.push(["front",id]),
    onPromote:id => calls.push(["promote",id]),
    onDefer:id => calls.push(["defer",id]),
  };
  const view = new CocoPromptQueueView(); document.body.append(view.root);
  view.setHandlers(handlers); view.setItems(items);
  return { view, calls, button: (label: string) => [...view.root.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label)! };
}

test("queue collapse survives incoming items and resets after the bound queue empties", () => {
  const f = fixture();
  const toggle = f.view.root.querySelector<HTMLButtonElement>(".coco-queue-toggle")!;
  toggle.click(); assert.equal(toggle.getAttribute("aria-expanded"),"false");
  f.view.setItems([item("a"),item("b"),item("c")]);
  assert.equal(f.view.root.querySelector<HTMLElement>(".coco-queue-rows")!.hidden,true);
  assert.equal(f.view.root.querySelector(".coco-queue-count")?.textContent,"· 3");
  f.view.setItems([]); assert.equal(f.view.root.hidden,true);
  f.view.setItems([item("new-session")]);
  assert.equal(toggle.getAttribute("aria-expanded"),"true");
  assert.equal(f.view.root.hidden,false); f.view.destroy();
});

test("insert, undo and idle send use the same queue handlers without draining on idle", () => {
  const f = fixture([item("a")]);
  f.button("Insert after the current step").click();
  f.view.setItems([item("a","interrupt")]);
  assert.equal(f.view.root.querySelector(".coco-queue-hint")?.textContent,"After current step");
  f.button("Wait until this turn ends").click();
  f.view.setSessionIdle(true);
  assert.equal(f.view.root.querySelector(".coco-queue-hint")?.textContent,"Ready to send");
  assert.equal(f.view.root.querySelector(".is-armed"),null);
  assert.equal(f.view.root.querySelectorAll(".coco-queue-row").length,1);
  assert.deepEqual(f.calls,[["promote","a"],["defer","a"]]);
  f.button("Send now").click(); assert.deepEqual(f.calls.at(-1),["promote","a"]); f.view.destroy();
});

test("drafts survive queue updates; cancel never mutates the queued prompt and Save does", () => {
  const f = fixture();
  f.view.root.querySelector<HTMLButtonElement>(".coco-queue-text")!.click();
  let editor = f.view.root.querySelector<HTMLTextAreaElement>("textarea")!;
  editor.value = "Unsaved text";
  editor.dispatchEvent(new window.Event("input"));
  f.view.setItems([item("a"),item("b","interrupt")]);
  editor = f.view.root.querySelector<HTMLTextAreaElement>("textarea")!;
  assert.equal(editor.value,"Unsaved text");
  f.button("Cancel").click(); assert.deepEqual(f.calls,[]);
  f.view.root.querySelector<HTMLButtonElement>(".coco-queue-text")!.click();
  editor = f.view.root.querySelector<HTMLTextAreaElement>("textarea")!;
  editor.value = "Edited text"; f.button("Save").click();
  assert.deepEqual(f.calls,[["edit","a","Edited text"]]);
  f.view.setItems([item("b")]); assert.equal(f.view.root.querySelector("textarea"),null); f.view.destroy();
});

test("more-actions popover forwards edit, reorder and removal and closes on snapshots", () => {
  const f = fixture();
  f.button("More actions for message 2").click();
  assert.equal(f.view.root.querySelector(".coco-queue-menu")?.getAttribute("data-open"),"true");
  f.button("Move to front").click(); assert.deepEqual(f.calls,[["front","b"]]);
  f.button("More actions for message 1").click(); assert.equal(f.button("Move to front").disabled,true);
  f.button("Edit").click(); assert.equal(f.view.root.querySelector<HTMLTextAreaElement>("textarea")?.value,"Message a");
  f.button("Cancel").click();
  f.button("More actions for message 2").click(); f.button("Remove").click();
  assert.deepEqual(f.calls.at(-1),["remove","b"]);
  f.button("More actions for message 2").click(); f.view.setItems([item("a")]);
  assert.equal(f.view.root.querySelector(".coco-queue-menu")?.hasAttribute("data-open"),false);
  f.view.destroy(); assert.equal(f.view.root.childElementCount,0);
});

test("attachment-only prompts remain identifiable and identical refreshes preserve editor DOM", () => {
  const attached: PromptQueueItem = { ...item("attachment"),text:"",attachments:[{id:"file",name:"notes.md",kind:"text",path:"/notes.md",mimeType:"text/markdown"}] };
  const f = fixture([attached]);
  assert.equal(f.view.root.querySelector(".coco-queue-text")?.textContent,"notes.md");
  assert.equal(f.view.root.querySelector(".coco-queue-attachments")?.title,"notes.md");
  f.view.root.querySelector<HTMLButtonElement>(".coco-queue-text")!.click();
  const editor = f.view.root.querySelector("textarea"); f.view.setItems([attached]);
  assert.equal(f.view.root.querySelector("textarea"),editor); f.view.destroy();
});

test("empty edits stay open while Chinese input composition does not submit or cancel", () => {
  const f = fixture([item("a")]);
  f.view.root.querySelector<HTMLButtonElement>(".coco-queue-text")!.click();
  const editor = f.view.root.querySelector<HTMLTextAreaElement>("textarea")!;
  editor.value = " "; f.button("Save").click();
  assert.equal(f.view.root.querySelector("textarea"),editor);
  assert.equal(editor.dataset.validationMessage,"Message cannot be empty.");
  editor.value = "新消息"; editor.dispatchEvent(new window.Event("input"));
  const composing = new window.Event("keydown");
  Object.assign(composing,{key:"Enter",isComposing:true}); editor.dispatchEvent(composing);
  assert.deepEqual(f.calls,[]); assert.equal(f.view.root.querySelector("textarea"),editor);
  const enter = new window.Event("keydown"); Object.assign(enter,{key:"Enter",isComposing:false}); editor.dispatchEvent(enter);
  assert.deepEqual(f.calls,[["edit","a","新消息"]]); f.view.destroy();
});
