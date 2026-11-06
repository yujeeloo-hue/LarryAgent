import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { CocoSnapshot, CocoWork, CocoWorkResult } from "../../../../coco/types.js";
import { defaultSettings } from "../../../../coco/validation.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
let CocoWorkResultView: typeof import("./CocoWorkResultView.js")["CocoWorkResultView"];
test.before(async () => { ({ CocoWorkResultView } = await import("./CocoWorkResultView.js")); });
const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document, window, matchMedia: () => ({ matches: true }) });
window.HTMLElement.prototype.scrollIntoView = () => {};
const now = Date.UTC(2026,10,2,1,45);
const work = (id="work"): CocoWork => ({id,goalId:"goal",title:"Weekly report",objective:"Write a report",workspaceId:"project",status:"completed",priority:50,dependsOn:[],steps:[],acceptance:[{id:"criterion",description:"Contains actual findings",kind:"review"}],deliverables:[],ruleIds:[],revision:2,repairs:0,fullPermissions:true,providerId:"",createdAt:now-60000,updatedAt:now,summary:"Task verified",timeline:[{at:now-60000,text:"Plan saved"},{at:now-40000,text:"Writing the report",status:"executing"},{at:now,text:"Verified the output",status:"completed",revision:2}]});
const snapshot = (): Pick<CocoSnapshot,"settings"|"attempts"|"verifications"> => ({settings:{...defaultSettings(),timezone:"Asia/Shanghai"},attempts:[{id:"attempt",workId:"work",revision:2,status:"finished",startedAt:now-50000,endedAt:now}],verifications:[{id:"verify",workId:"work",revision:2,at:now,passed:true,summary:"The saved report satisfies the goal",checks:[{criterionId:"task",passed:true,evidence:"Verified as a whole"}]}]});
const report = (patch:Partial<CocoWorkResult>={}): CocoWorkResult => ({id:"report",workId:"work",revision:2,attemptId:"attempt",at:now-5000,capturedAt:now,title:"Weekly findings",markdown:"# Weekly findings\n\nContains **actual findings** and a next step.",source:"report",...patch});
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("puts the saved report above a semantic time axis and plain acceptance section", async () => {
  const view=new CocoWorkResultView({load:async()=>[report()],notice:()=>{},layoutChanged:()=>{}});
  view.render(work(),snapshot()); await settle();
  assert.deepEqual([...view.root.querySelectorAll(".coco-detail-section")].map(node=>node.className),["coco-detail-section coco-work-results","coco-detail-section coco-progress-timeline","coco-detail-section coco-result-acceptance"]);
  assert.equal(view.root.querySelector(".coco-section"),null,"there are no nested cards");
  assert.equal(view.root.querySelector(".coco-work-result-body strong")?.textContent,"actual findings");
  assert.equal(view.root.querySelectorAll(".coco-result-title").length,1);
  assert.equal(view.root.querySelector(".coco-work-result-body h1"),null,"the document title is not repeated");
  assert.equal(view.root.querySelectorAll("ol.coco-progress-events>li").length,4);
  assert.equal(view.root.querySelector(".coco-progress-time")?.textContent,"09:44");
  assert.match(view.root.querySelector(".coco-timeline-day")!.textContent!,/Nov 2, 2026.*Asia\/Shanghai/);
  assert.match(view.root.querySelector(".coco-result-meta")!.textContent!,/Saved report.*Attempt 1/);
  assert.equal(view.root.querySelector(".coco-acceptance-status")!.textContent,"Verified");
  assert.equal(view.root.querySelector(".coco-criterion-passed"),null,"aggregate task verification never pretends each criterion was individually checked");
});

test("selects the actual report over an execution summary and opens earlier versions from the timeline", async () => {
  const current=report(), old=report({id:"old",revision:1,at:now-86400000,title:"Previous findings",markdown:"Earlier content"});
  const view=new CocoWorkResultView({load:async()=>[current,old,report({id:"reply",source:"message",title:"Execution result",markdown:"Report written."})],notice:()=>{},layoutChanged:()=>{}});
  view.render(work(),snapshot()); await settle();
  const select=view.root.querySelector<HTMLSelectElement>("select")!;
  assert.equal(select.querySelectorAll("option").length,2,"the report replaces its attempt's summary reply");
  assert.match(view.root.querySelector(".coco-result-title")!.textContent!,/Weekly findings/);
  const oldLink=[...view.root.querySelectorAll<HTMLButtonElement>(".coco-result-timeline-link")].find(link=>link.textContent==="Previous findings")!;
  oldLink.click();
  assert.equal(view.root.querySelector(".coco-work-result-body")!.textContent,"Earlier content");
  assert.match(view.root.querySelector(".coco-result-meta")!.textContent!,/Earlier requirements · Revision 1/);
});

test("long reports expand without clipping blocks and keep expansion after a snapshot refresh", async () => {
  const long=report({markdown:"# Weekly findings\n\n"+Array.from({length:10},(_,i)=>`## Finding ${i}\n\n${"Concrete result. ".repeat(20)}`).join("\n\n")});
  const view=new CocoWorkResultView({load:async()=>[long],notice:()=>{},layoutChanged:()=>{}});
  view.render(work(),snapshot()); await settle();
  const toggle=view.root.querySelector<HTMLButtonElement>(".coco-result-expand")!;
  assert.equal(toggle.getAttribute("aria-expanded"),"false");
  assert.ok(view.root.querySelector(".coco-work-result-body>[hidden]"));
  toggle.click(); assert.equal(toggle.getAttribute("aria-expanded"),"true"); assert.equal(view.root.querySelector(".coco-work-result-body>[hidden]"),null);
  view.render({...work(),updatedAt:now+1},snapshot()); await settle();
  assert.equal(view.root.querySelector(".coco-result-expand")?.getAttribute("aria-expanded"),"true");
});

test("ignores stale requests when another task opens and shows an English empty state", async () => {
  let finish: (results:CocoWorkResult[])=>void = ()=>{};
  const view=new CocoWorkResultView({load:id=>id==="work"?new Promise(resolve=>{finish=resolve;}):Promise.resolve([]),notice:()=>{},layoutChanged:()=>{}});
  view.render(work(),snapshot()); view.render(work("other"),snapshot()); await settle(); finish([report()]); await settle();
  assert.equal(view.root.querySelector(".coco-work-result-document"),null);
  assert.match(view.root.textContent!,/No readable output was saved for this run/);
  assert.equal(view.root.textContent!.includes("Weekly findings"),false);
});

test("groups days in the selected timezone and expands failed verification", async () => {
  const task=work(), s=snapshot();
  task.timeline=[{at:Date.UTC(2026,10,1,15,59),text:"Old event"},{at:Date.UTC(2026,10,1,16,1),text:"Question",status:"to_decide"}];
  s.verifications[0]!.passed=false;
  const view=new CocoWorkResultView({load:async()=>[],notice:()=>{},layoutChanged:()=>{}}); view.render(task,s); await settle();
  assert.equal(view.root.querySelectorAll(".coco-timeline-day").length,2);
  assert.equal(view.root.querySelector<HTMLDetailsElement>(".coco-result-acceptance")!.open,true);
  assert.equal(view.root.querySelector(".coco-acceptance-status")!.textContent,"Needs review");
  assert.ok(view.root.querySelector(".coco-progress-event.is-to_decide"));
});
