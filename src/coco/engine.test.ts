import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CocoRepository } from "./repository.js";
import { budgetState, CocoEngine, type CocoPorts } from "./engine.js";
import { defaultSettings, validatePlan, validateSettings } from "./validation.js";
import type { CocoRule, CocoWork } from "./types.js";
import { CocoStartup } from "./startup.js";
import { CocoContextCapacityError } from "./contextErrors.js";

const plan = (title = "Create a report", key = "report") => ({ reply: "I saved the plan.", planOnly: false, work: [{ key, title, objective: "Write a report with concrete findings", workspaceId: "p1", priority: 50, dependsOn: [], steps: ["Review", "Write"], acceptance: [{ id: "c1", description: "Contains concrete findings", kind: "review" }], deliverables: [] }], ruleSuggestions: [] });
const pass = { action: "complete" as const, reason: "The saved goal is done" };
function fixture(overrides: Partial<CocoPorts> = {}) {
  const db = new DatabaseSync(":memory:"), repository = new CocoRepository(db);
  // Heartbeat behaviour has its own tests; keep it out of the way of clock-advancing ones.
  repository.setMeta("settings", { ...defaultSettings(), enabled: true, heartbeatMinutes: 240 });
  let now = Date.UTC(2026, 9, 28, 2), executed = 0;
  const ports: CocoPorts = {
    context: () => ({ workspaces: [{ id: "p1", name: "Project" }], sessions: [] }),
    model: async (purpose, _input, _signal, usage) => { usage(10, false, String(now)); return purpose === "plan" ? plan() : purpose === "report" ? { markdown: "# Daily report" } : pass; },
    execute: async (_work, _settings, _signal, usage, attach) => { executed++; usage(10, false, `execution-${executed}`); attach(`session-${executed}`); return { summary: "Turn ended", evidence: {} }; }, ...overrides,
  };
  const engine = new CocoEngine(repository, ports, () => now);
  return { db, repository, engine, executed: () => executed, time: () => now, advance: (ms: number) => { now += ms; }, async close() { engine.stop(); await engine.settled(); db.close(); } };
}
async function until(predicate: () => boolean): Promise<void> {
  for (let i=0;i<100;i++) { if (predicate()) return; await new Promise<void>(resolve => setImmediate(resolve)); }
  assert.ok(predicate(), "engine reached expected state");
}
test("chat → persisted acceptance → execution session → independent verification", async () => {
  const f = fixture(); f.engine.start(); f.engine.command({ type: "chat", text: "Create a report", workspaceId: "p1" });
  await until(() => f.engine.snapshot().work[0]?.status === "completed");
  const snapshot = f.engine.snapshot(); assert.equal(f.executed(), 1); assert.equal(snapshot.verifications.length, 1); assert.equal(snapshot.work[0]?.sessionId, "session-1"); assert.equal(snapshot.attempts[0]?.revision, 1);
  assert.match(snapshot.work[0]!.timeline[0]!.text, /criteria saved before execution/); await f.close();
});
test("a runtime turn ending never completes a work item without verification", async () => {
  let release!: (value: unknown) => void;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ model: async purpose => purpose === "plan" ? plan() : gate });
  f.engine.start(); f.engine.command({ type: "chat", text: "Do it" }); await until(() => f.engine.snapshot().state === "working" && f.engine.snapshot().work[0]?.status === "verifying");
  assert.equal(f.engine.snapshot().work[0]?.status, "verifying"); assert.equal(f.engine.snapshot().verifications.length, 0); release(pass); await until(() => f.engine.snapshot().work[0]?.status === "completed"); await f.close();
});
test("tasks in one workspace share one execution slot", async () => {
  let active = 0, max = 0, sequence = 0;
  const f = fixture({ model: async purpose => purpose === "plan" ? plan(`Task ${++sequence}`) : pass, execute: async () => { active++; max = Math.max(max, active); await new Promise<void>(resolve => setImmediate(resolve)); active--; return { summary: "Done", evidence: {} }; } });
  f.engine.start(); f.engine.command({ type: "chat", text: "One" }); f.engine.command({ type: "chat", text: "Two" });
  await Promise.all([f.engine.tick(), f.engine.tick(), f.engine.tick()]); await until(() => f.engine.snapshot().work.filter(w => w.status === "completed").length === 2); assert.equal(max, 1); await f.close();
});
test("tasks in different workspaces run together", async () => {
  let active = 0, max = 0;
  const release = new Map<string, () => void>();
  const f = fixture({
    context: () => ({ workspaces: [{ id: "p1", name: "One" }, { id: "p2", name: "Two" }], sessions: [] }),
    model: async (purpose, input) => {
      if (purpose !== "plan") return pass;
      const request = String((input as { request?: unknown }).request ?? "");
      const workspaceId = request.includes("other project") ? "p2" : "p1";
      const title = request.includes("other project") ? "Other" : request.includes("follow-up") ? "Follow-up" : "First";
      const saved = plan(title, title.toLowerCase());
      saved.work[0]!.workspaceId = workspaceId;
      return saved;
    },
    execute: async work => {
      active++; max = Math.max(max, active);
      await new Promise<void>(resolve => { release.set(work.id, resolve); });
      active--;
      return { summary: "Done", evidence: {} };
    },
  });
  try {
    f.engine.start();
    f.engine.command({ type: "chat", text: "First" });
    f.engine.command({ type: "chat", text: "Do this in the other project" });
    await until(() => active === 2);
    assert.equal(f.engine.snapshot().work.filter(work => work.status === "executing").length, 2);
    f.engine.command({ type: "chat", text: "follow-up in the first project" });
    await until(() => f.engine.snapshot().work.some(work => work.title === "Follow-up"));
    assert.equal(f.engine.snapshot().work.find(work => work.title === "Follow-up")?.status, "queued");
    assert.equal(active, 2);
    const first = f.engine.snapshot().work.find(work => work.title === "First")!;
    release.get(first.id)!();
    await until(() => f.engine.snapshot().work.find(work => work.title === "Follow-up")?.status === "executing");
    assert.equal(f.engine.snapshot().work.find(work => work.title === "Other")?.status, "executing");
    assert.ok(max >= 2);
    for (const done of [...release.values()]) done();
    await until(() => f.engine.snapshot().work.every(work => work.status === "completed"));
  } finally {
    for (const done of [...release.values()]) done();
    await f.close();
  }
});
test("plan-only requests stay drafts until explicitly started", async () => {
  const f = fixture(); f.engine.start(); f.engine.command({ type: "chat", text: "Plan this", planOnly: true }); await until(() => f.engine.snapshot().work.length === 1);
  assert.equal(f.executed(), 0); assert.equal(f.engine.snapshot().work[0]?.status, "draft"); f.engine.command({ type: "work", id: f.engine.snapshot().work[0]!.id, action: "start" }); await until(() => f.engine.snapshot().work[0]?.status === "completed"); await f.close();
});
test("natural-language plan-only interpretation stays a draft without a UI toggle", async () => {
  const f=fixture({model:async()=>({...plan(),planOnly:true})}); f.engine.start(); f.engine.command({type:"chat",text:"First give me a plan. Do not execute it yet."});
  await until(()=>f.engine.snapshot().work.length===1); assert.equal(f.engine.snapshot().work[0]?.status,"draft"); assert.equal(f.executed(),0); await f.close();
});
test("three failed repair rounds stop with a durable decision", async () => {
  let checks = 0;
  const f = fixture({ model: async purpose => purpose === "plan" ? plan() : { action: "continue", prompt: `Try approach ${++checks}`, reason: "The goal is not done yet" } });
  f.engine.start(); f.engine.command({ type: "chat", text: "Fix it" }); await until(() => f.engine.snapshot().work[0]?.status === "to_decide");
  assert.equal(f.executed(), 4); assert.equal(f.engine.snapshot().work[0]?.repairs, 3); assert.equal(f.engine.snapshot().verifications.length, 4); await f.close();
});
test("budget finishes the active operation and cools down until the next natural window", async () => {
  // Chat planning spends 10 tokens and execution 10 more: the ceiling sits
  // between them, so the run trips the budget only once execution is underway.
  const f = fixture(); f.repository.setMeta("settings", { ...defaultSettings(), enabled: true, timezone: "Asia/Shanghai", hourlyTokens: 15, dailyTokens: 1000 });
  f.engine.start(); f.engine.command({ type: "chat", text: "Create it" }); await until(() => f.engine.snapshot().state === "cooldown");
  assert.equal(f.engine.snapshot().work.length, 1); assert.equal(f.executed(), 1); assert.equal(f.engine.snapshot().work[0]?.status,"verifying"); assert.ok(f.engine.snapshot().resumeAt);
  f.advance(3600000); await f.engine.tick(); await until(() => f.engine.snapshot().work[0]?.status === "completed"); await f.close();
});
test("budget soft-pauses mid-execute and auto-resumes after the window resets", async () => {
  let executes = 0;
  const resumed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({
    model: async (purpose, _input, _signal, usage) => {
      usage(1, false, `model-${purpose}`);
      return purpose === "plan" ? plan() : purpose === "report" ? { markdown: "# Daily report" } : pass;
    },
    execute: async (_work, _settings, _signal, usage, attach) => {
      executes++;
      usage(10, false, `execution-${executes}`);
      attach(`session-${executes}`);
      if (executes === 1) {
        await gate;
        return { summary: "Token budget reached; paused until the budget resets.", deferred: true, budgetHold: true, evidence: {} };
      }
      return { summary: "Turn ended", evidence: {} };
    },
    resumeBudgetHold: async sessionId => { resumed.push(sessionId); },
  });
  f.repository.setMeta("settings", { ...defaultSettings(), enabled: true, timezone: "Asia/Shanghai", hourlyTokens: 5, dailyTokens: 1000 });
  f.engine.start();
  f.engine.command({ type: "chat", text: "Create it" });
  await until(() => executes === 1);
  release();
  await until(() => f.engine.snapshot().work[0]?.status === "queued" && f.engine.snapshot().work[0]?.budgetHold === true);
  assert.equal(f.engine.snapshot().state, "cooldown");
  assert.equal(executes, 1);
  assert.equal(resumed.length, 0);
  assert.match(f.engine.snapshot().work[0]!.summary, /budget/);
  f.advance(3600000);
  await f.engine.tick();
  await until(() => executes === 2 && resumed.length === 1 && f.engine.snapshot().work[0]?.budgetHold !== true);
  assert.deepEqual(resumed, ["session-1"]);
  // Second execute re-fills the hourly ceiling; verification waits for the next window.
  f.advance(3600000);
  await f.engine.tick();
  await until(() => f.engine.snapshot().work[0]?.status === "completed");
  await f.close();
});
test("resetting the budget continues a held task without waiting for the window", async () => {
  let executes = 0;
  const resumed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({
    model: async (purpose, _input, _signal, usage) => {
      usage(1, false, `model-${purpose}`);
      return purpose === "plan" ? plan() : pass;
    },
    execute: async (_work, _settings, _signal, usage, attach) => {
      executes++;
      usage(10, false, `execution-${executes}`);
      attach(`session-${executes}`);
      if (executes === 1) {
        await gate;
        return { summary: "Token budget reached; paused until the budget resets.", deferred: true, budgetHold: true, evidence: {} };
      }
      return { summary: "Turn ended", evidence: {} };
    },
    resumeBudgetHold: async sessionId => { resumed.push(sessionId); },
  });
  f.repository.setMeta("settings", { ...defaultSettings(), enabled: true, timezone: "Asia/Shanghai", hourlyTokens: 5, dailyTokens: 1000 });
  f.engine.start();
  f.engine.command({ type: "chat", text: "Create it" });
  await until(() => executes === 1);
  release();
  await until(() => f.engine.snapshot().work[0]?.budgetHold === true && f.engine.snapshot().state === "cooldown");
  f.engine.command({ type: "budget", action: "reset" });
  await until(() => executes === 2 && resumed.length === 1 && f.engine.snapshot().work[0]?.budgetHold !== true);
  assert.deepEqual(resumed, ["session-1"]);
  await f.close();
});
test("user pause waits for an explicit resume and never auto-clears as budgetHold", async () => {
  let executes = 0;
  const f = fixture({
    execute: async (_work, _settings, _signal, usage, attach) => {
      executes++;
      usage(10, false, "execution-user-pause");
      attach("session-user-pause");
      return {
        summary: "Paused by you",
        paused: "The task session was stopped or paused by you. CoCo will wait for an explicit resume.",
        evidence: {},
      };
    },
  });
  f.engine.start();
  f.engine.command({ type: "chat", text: "Create it" });
  await until(() => f.engine.snapshot().work[0]?.status === "waiting");
  assert.equal(f.engine.snapshot().work[0]?.budgetHold, false);
  assert.match(f.engine.snapshot().work[0]!.summary, /Paused by you|explicit resume/);
  f.advance(3600000);
  await f.engine.tick();
  assert.equal(f.engine.snapshot().work[0]?.status, "waiting");
  assert.equal(executes, 1);
  await f.close();
});
test("budget windows follow the selected timezone and daily exhaustion waits for midnight", () => {
  const now = Date.UTC(2026, 9, 28, 15, 50), settings = { ...defaultSettings(), timezone: "Asia/Shanghai", hourlyTokens: 100, dailyTokens: 10 };
  const budget = budgetState([{ id: "r", at: now, tokens: 10, estimated: false, purpose: "plan" }], settings, now);
  assert.equal(budget.resumeAt, Date.UTC(2026, 9, 28, 16)); assert.throws(() => validateSettings({ ...settings, dailyTokens: -1 }));
});
test("a repeated daylight-saving hour opens a distinct natural budget window",()=>{
  const now=Date.UTC(2026,10,1,5,55), settings={...defaultSettings(),timezone:"America/New_York",hourlyTokens:10};
  const result=budgetState([{id:"usage",at:now,tokens:10,estimated:false,purpose:"execute"}],settings,now);
  assert.equal(result.resumeAt,Date.UTC(2026,10,1,6));
});
const rule = (at: number): CocoRule => ({ id: "r1", name: "Inspect", objective: "Find real work", mode: "inspection", scope: { all: true, workspaceIds: [], excludedWorkspaceIds: [] }, enabled: true, confirmed: true, fullPermissions: false, providerId: "", cadence: { kind: "minute", n: 15 }, acceptance: [], nextRunAt: at, createdAt: 0 });
test("startup skips missed schedules; rules run only on their schedule", async () => {
  let plans = 0;
  const f = fixture({ model: async () => { plans++; return { ...plan(), work: [] }; } });
  f.repository.put("rule", rule(1)); f.engine.start(); await f.engine.tick(); assert.equal(plans, 0);
  f.advance(15 * 60000); await f.engine.tick(); await until(() => plans === 1); await f.close();
});
test("legacy check-in rules become paused inspections and event triggers are dropped", async () => {
  const f = fixture();
  try {
    f.repository.put("rule", { ...rule(f.time() + 60000), id: "c1", mode: "checkin", events: ["git_changed"] } as unknown as CocoRule);
    f.repository.put("rule", { ...rule(f.time() + 60000), id: "f1", mode: "fixed", events: [] } as unknown as CocoRule);
    f.engine.start();
    const checkin = f.repository.get<CocoRule & { events?: unknown }>("rule", "c1")!, fixed = f.repository.get<CocoRule & { events?: unknown }>("rule", "f1")!;
    assert.equal(checkin.mode, "inspection"); assert.equal(checkin.enabled, false); assert.equal(checkin.events, undefined);
    assert.equal(fixed.mode, "fixed"); assert.equal(fixed.enabled, true); assert.equal(fixed.nextRunAt, f.time() + 60000); assert.equal(fixed.events, undefined);
  } finally { await f.close(); }
});
test("inspection rules retain their own intervals",async()=>{
  const f=fixture(); f.repository.put("rule",{...rule(0),cadence:{kind:"minute",n:3}}); f.engine.start();
  assert.equal(f.engine.snapshot().rules[0]!.nextRunAt-f.time(),180000); await f.close();
});
test("restarts keep a pending interval schedule instead of restarting its countdown", async () => {
  const f = fixture(); const due = f.time() + 10 * 60000;
  f.repository.put("rule", { ...rule(due), cadence: { kind: "minute", n: 60 } }); f.engine.start();
  assert.equal(f.engine.snapshot().rules[0]!.nextRunAt, due); await f.close();
});
test("restarts skip missed interval occurrences while keeping the original phase", async () => {
  const f = fixture(); const missed = f.time() - 25 * 60000;
  f.repository.put("rule", { ...rule(missed), cadence: { kind: "minute", n: 60 } }); f.engine.start(); await f.engine.tick();
  assert.equal(f.engine.snapshot().rules[0]!.nextRunAt, missed + 60 * 60000);
  assert.equal(f.repository.list<{ kind: string }>("job").filter(j => j.kind === "inspect" && "ruleId" in j).length, 0); await f.close();
});
test("a due rule stays pending while every project in its scope is busy, then runs once one is idle", async () => {
  let plans = 0, sessionStatus = "running";
  const f = fixture({
    context: () => ({ workspaces: [{ id: "p1", name: "Project" }], sessions: [{ id: "user-turn", workspaceId: "p1", title: "User turn", status: sessionStatus, updatedAt: 1 }] }),
    model: async () => { plans++; return { ...plan(), work: [] }; },
  });
  f.repository.put("rule", rule(f.time() + 1000)); f.engine.start();
  f.advance(1000); await f.engine.tick();
  assert.equal(plans, 0);
  assert.equal(f.engine.snapshot().rules[0]!.nextRunAt, f.time(), "a fully busy scope keeps the scheduled run due");
  sessionStatus = "idle"; await f.engine.tick();
  await until(() => plans === 1);
  assert.ok(f.engine.snapshot().rules[0]!.nextRunAt > f.time());
  await f.close();
});
test("rule-generated work waits for a live session turn in its target project before deploying", async () => {
  let sessionStatus = "running", executes = 0;
  const f = fixture({
    context: () => ({ workspaces: [{ id: "p1", name: "Idle project" }, { id: "p2", name: "Busy project" }], sessions: [{ id: "user-turn", workspaceId: "p2", title: "User turn", status: sessionStatus, updatedAt: 1 }] }),
    model: async () => { const saved = plan(); saved.work[0]!.workspaceId = "p2"; return saved; },
    execute: async () => { executes++; return { summary: "Turn ended", evidence: {} }; },
  });
  f.repository.put("rule", rule(f.time() + 1000)); f.engine.start();
  f.advance(1000); await f.engine.tick();
  await until(() => f.engine.snapshot().work.length === 1 && f.engine.snapshot().work[0]?.status === "queued");
  await f.engine.tick(); await f.engine.tick();
  assert.equal(executes, 0, "deployment holds while the target project has a live turn");
  assert.equal(f.engine.snapshot().work[0]?.status, "queued");
  sessionStatus = "idle"; await f.engine.tick();
  await until(() => executes === 1);
  await f.close();
});
test("failed rule runs retry with backoff before reporting the failure", async () => {
  let runs = 0;
  const f = fixture({ model: async () => { runs++; throw new Error("fetch failed"); } });
  f.repository.put("rule", rule(f.time() + 1000)); f.engine.start();
  const failures = () => f.engine.snapshot().messages.filter(m => m.text.startsWith("CoCo could not complete"));
  f.advance(1000); await f.engine.tick(); await until(() => runs === 1);
  await until(() => f.repository.list<{ kind: string; status: string; retries?: number }>("job").some(j => j.kind === "inspect" && j.status === "queued" && j.retries === 1));
  assert.equal(failures().length, 0);
  for (const delay of [60000, 300000, 900000]) { f.advance(delay); await f.engine.tick(); await until(() => runs === 2 + [60000, 300000, 900000].indexOf(delay)); }
  await until(() => failures().length === 1);
  assert.match(failures()[0]!.text, /after 4 attempts: fetch failed/);
  const recorded = f.engine.snapshot().ruleRuns!;
  assert.equal(recorded.length, 1); assert.equal(recorded[0]!.status, "failed"); assert.equal(recorded[0]!.attempts, 4); assert.equal(recorded[0]!.error, "fetch failed"); await f.close();
});
test("rule runs record CoCo's summary and the planned work", async () => {
  const f = fixture();
  f.repository.put("rule", { ...rule(f.time() + 1000), mode: "fixed" }); f.engine.start();
  f.advance(1000); await f.engine.tick();
  await until(() => f.engine.snapshot().ruleRuns?.[0]?.status === "planned");
  const run = f.engine.snapshot().ruleRuns![0]!;
  assert.equal(run.ruleName, "Inspect"); assert.equal(run.summary, "I saved the plan."); assert.deepEqual(run.workIds, f.engine.snapshot().work.map(w => w.id)); assert.ok(run.endedAt); await f.close();
});
test("quit aborts active work and restart requires review rather than replaying possible effects", async () => {
  let entered = false;
  const f = fixture({ execute: async (_w,_s,signal) => { entered = true; await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); signal.throwIfAborted(); return { summary: "", evidence: {} }; } });
  f.engine.start(); f.engine.command({ type: "chat", text: "Do it" }); await until(() => entered); f.engine.stop(); await f.engine.settled();
  assert.equal(f.engine.snapshot().work[0]?.status, "to_decide"); f.engine.start(); await f.engine.tick(); assert.equal(f.engine.snapshot().work[0]?.status, "to_decide"); assert.equal(f.engine.snapshot().attempts[0]?.status, "interrupted"); await f.close();
});
test("malformed plans, unavailable projects and dependency cycles fail before execution", () => {
  assert.throws(() => validatePlan(plan(), new Set(), new Set()), /unavailable project/);
  const cyclic = plan(); cyclic.work[0]!.dependsOn = ["report"]; assert.throws(() => validatePlan(cyclic, new Set(["p1"]), new Set()), /Cyclic/);
  const missing = plan(); missing.work[0]!.acceptance = []; assert.throws(() => validatePlan(missing, new Set(["p1"]), new Set()), /acceptance criteria/);
});
test("a needs_user judgment waits for a decision instead of accepting an unfinished task", async () => {
  const f = fixture({ model: async purpose => purpose === "plan" ? plan() : { action: "needs_user", question: "Which audience is this for?", reason: "The audience changes the goal" } });
  f.engine.start(); f.engine.command({ type: "chat", text: "Do it" }); await until(() => f.engine.snapshot().work[0]?.status === "to_decide");
  assert.equal(f.engine.snapshot().work[0]?.decisionPrompt?.question, "Which audience is this for?");
  assert.equal(f.engine.snapshot().verifications.every(v => !v.passed), true); await f.close();
});
test("another runtime cannot normalize or execute work while the database lease is held", async () => {
  const f = fixture(); f.engine.start();
  const second = new CocoEngine(f.repository,{ context:()=>({workspaces:[],sessions:[]}),model:async()=>{throw new Error("Must not run");},execute:async()=>{throw new Error("Must not run");} }, f.time);
  second.start(); assert.equal(second.snapshot().state,"blocked"); assert.throws(()=>second.command({type:"chat",text:"Unsafe duplicate"}),/another Larry Agent instance/);
  second.stop(); assert.equal(f.engine.ownsExecution(),true); await f.close();
});
test("a dead owner's leftover lease blocks only until expiry, then start retries take over", async () => {
  const f = fixture();
  // Previous process died via the update/restart fast-exit or a crash: its
  // lease row (15s TTL) is left behind with no one renewing it.
  f.repository.acquireLease("dead-owner", f.time());
  const second = new CocoEngine(f.repository,{ context:()=>({workspaces:[{id:"p1",name:"P"}],sessions:[]}), model:async()=>pass, execute:async()=>({summary:"",evidence:{}}) }, f.time, 10);
  try {
    second.start();
    assert.equal(second.snapshot().state,"blocked"); assert.match(String(second.snapshot().error),/another Larry Agent instance/);
    assert.throws(()=>second.command({type:"chat",text:"Unsafe duplicate"}),/another Larry Agent instance/);
    // While the lease is still valid, retries must never steal it.
    await new Promise(resolve=>setTimeout(resolve,50)); assert.equal(second.ownsExecution(),false);
    // TTL lapsed: the next retry boots on its own — no app restart needed.
    // Poll on real timers: the lease retry is a real setTimeout, which lags
    // behind `until`'s setImmediate spin under full-suite CPU contention.
    f.advance(16000);
    for (let i=0;i<300 && !second.ownsExecution();i++) await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(second.ownsExecution(),true,"expired lease is taken over by the start retry");
    assert.equal(second.snapshot().state,"idle"); assert.equal(second.snapshot().error,undefined);
  } finally { second.stop(); await second.settled(); await f.close(); }
});
test("stop releases the runtime lease even with work in flight, so an updated instance starts immediately", async () => {
  let release!: (value: unknown) => void;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture({ model: async purpose => purpose === "plan" ? plan() : gate });
  f.engine.start(); f.engine.command({ type: "chat", text: "Do it" }); await until(() => f.engine.snapshot().work[0]?.status === "verifying");
  // The update/restart fast-exit path stops CoCo and is gone within 400ms —
  // no drain. The lease must not outlive the stopped runtime.
  f.engine.stop();
  const second = new CocoEngine(f.repository,{ context:()=>({workspaces:[{id:"p1",name:"P"}],sessions:[]}), model:async()=>pass, execute:async()=>({summary:"",evidence:{}}) }, f.time);
  try {
    second.start();
    assert.equal(second.ownsExecution(),true); assert.notEqual(second.snapshot().state,"blocked");
  } finally { release(pass); second.stop(); await second.settled(); await f.engine.settled(); await f.close(); }
});
test("chat can revise an existing draft and invalidate its prior acceptance revision", async () => {
  let request=0;
  const f=fixture({model:async purpose=> purpose!=="plan"?pass:++request===1?plan():{reply:"Updated the acceptance criteria",planOnly:true,work:[],ruleSuggestions:[],changes:[{workId:f.engine.snapshot().work[0]!.id,action:"revise",objective:"Produce a concise report",acceptance:[{id:"c2",description:"The report is concise",kind:"review"}]}]}});
  f.engine.start(); f.engine.command({type:"chat",text:"Plan the report",planOnly:true}); await until(()=>f.engine.snapshot().work.length===1);
  f.engine.command({type:"chat",text:"Make it concise and keep it as a draft",planOnly:true}); await until(()=>f.engine.snapshot().work[0]?.revision===2);
  assert.equal(f.engine.snapshot().work[0]?.status,"draft"); assert.equal(f.engine.snapshot().work[0]?.acceptance[0]?.id,"c2"); assert.equal(f.executed(),0); await f.close();
});
test("historical runs use stable pages without loading or losing the full history",async()=>{
  const f=fixture(); f.repository.put("rule",rule(0));
  for(let i=0;i<35;i++) f.repository.put("legacyRun",{id:`run-${String(i).padStart(2,"0")}`,ruleId:"r1",sessionId:null,status:"succeeded",startedAt:100,endedAt:101,error:null});
  const first=f.repository.history("r1"), second=f.repository.history("r1",first.nextCursor);
  assert.equal(first.runs.length,30); assert.equal(second.runs.length,5); assert.equal(new Set([...first.runs,...second.runs].map(r=>r.id)).size,35); assert.equal(f.engine.snapshot().legacyRuns.length,30); assert.equal(f.repository.list("legacyRun").length,35); await f.close();
});
test("waiting on a user turn yields the slot without resuming a paused session", async () => {
  let status="running", sequence=0;
  const f=fixture({context:()=>({workspaces:[{id:"p1",name:"P"}],sessions:[{id:"user-session",workspaceId:"p1",title:"Existing",status,updatedAt:1}]}),model:async purpose=>purpose!=="plan"?pass:++sequence===1?{...plan("Observe current work"),work:plan("Observe current work").work.map(w=>({...w,observeSessionId:"user-session"}))}:plan("Other task")});
  f.engine.start(); f.engine.command({type:"chat",text:"Follow this session"}); await until(()=>f.engine.snapshot().work[0]?.status==="waiting");
  f.engine.command({type:"chat",text:"Another task"}); await until(()=>f.engine.snapshot().work.some(w=>w.title==="Other task"&&w.status==="completed"));
  status="paused"; await f.engine.tick(); assert.equal(f.engine.snapshot().work[0]?.status,"to_decide"); await f.close();
});
test("a handed-over session is watched: its finished turn is verified and continued in the same session", async () => {
  let status = "running", verifyCalls = 0;
  const runs: { sessionId?: string | undefined; advance?: string | undefined; providerId: string }[] = [];
  const f = fixture({
    context: () => ({ workspaces: [{ id: "p1", name: "P" }], sessions: [{ id: "handed", workspaceId: "p1", title: "Probe", status, updatedAt: 1 }] }),
    model: async (purpose, input) => {
      if (purpose !== "verify") return pass;
      assert.match((input as { work: CocoWork }).work.objective, /handed this session over/);
      return ++verifyCalls === 1 ? { action: "continue", prompt: "继续执行吧", reason: "Plan written; implementation not started" } : pass;
    },
    execute: async work => { runs.push({ sessionId: work.sessionId, advance: work.advancePrompt, providerId: work.providerId }); return { summary: "Turn ended", evidence: {} }; },
  });
  f.engine.start();
  assert.equal(f.engine.watchSession({ sessionId: "handed", workspaceId: "p1", title: "Probe", providerId: "glm" }), true);
  assert.equal(f.engine.watchSession({ sessionId: "handed", workspaceId: "p1", title: "Probe" }), false);
  await until(() => f.engine.snapshot().work[0]?.status === "waiting");
  status = "idle"; await f.engine.tick();
  await until(() => f.engine.snapshot().work[0]?.status === "completed");
  assert.deepEqual(runs, [{ sessionId: undefined, advance: undefined, providerId: "glm" }, { sessionId: "handed", advance: "继续执行吧", providerId: "glm" }]);
  assert.equal(f.engine.watchSession({ sessionId: "handed", workspaceId: "p1", title: "Probe" }), true);
  await f.close();
});
test("take-back cancels hand-over supervision only", async () => {
  const f = fixture({ context: () => ({ workspaces: [{ id: "p1", name: "P" }], sessions: [{ id: "handed", workspaceId: "p1", title: "Probe", status: "running", updatedAt: 1 }] }) });
  f.engine.start(); f.engine.watchSession({ sessionId: "handed", workspaceId: "p1", title: "Probe" });
  await until(() => f.engine.snapshot().work[0]?.status === "waiting");
  f.engine.releaseSession("handed");
  assert.equal(f.engine.snapshot().work[0]?.status, "cancelled");
  await f.close();
});
test("queued inspections merge provenance and use shared Full permissions for the same work", async () => {
  const f=fixture(); f.repository.setMeta("settings",{...defaultSettings(),enabled:true,fullPermissions:true});
  f.repository.put("rule",{...rule(0),id:"wide",fullPermissions:true}); f.repository.put("rule",{...rule(0),id:"narrow",fullPermissions:false});
  f.engine.start(); f.engine.command({type:"rule",action:"run",id:"wide"}); f.engine.command({type:"rule",action:"run",id:"narrow"});
  await until(()=>f.engine.snapshot().rules.length===2 && f.engine.snapshot().work.some(w=>w.ruleIds.length===2));
  const work=f.engine.snapshot().work.find(w=>w.ruleIds.length===2)!; assert.equal(work.fullPermissions,true); assert.equal(f.engine.snapshot().work.length,1); await f.close();
});

test("typed tool approval requires a current waiting work item and is not a freeform resume", async () => {
  const f = fixture({ execute: async () => ({ summary: "Review tool", waiting: "Approval needed", evidence: {} }) });
  f.engine.start(); f.engine.command({ type: "chat", text: "Do it" }); await until(() => f.engine.snapshot().work[0]?.status === "to_decide");
  const work = f.engine.snapshot().work[0]!;
  f.repository.put("toolApproval", { id: "approval", workId: work.id, revision: work.revision, scope: "scope", toolName: "mcp__service__write", arguments: { project: "one" }, reason: "Review", at: f.time(), status: "pending" });
  assert.throws(() => f.engine.command({ type: "work", id: work.id, action: "resume", answer: "yes" }), /exact tool invocation/);
  f.engine.command({ type: "toolApproval", id: "approval", action: "deny" }); assert.equal(f.engine.snapshot().work[0]?.status, "waiting");
  assert.throws(() => f.engine.command({ type: "toolApproval", id: "approval", action: "approve" }), /no longer current/);
  await f.close();
});

test("a temporary legacy startup block recovers and accepts Chat without dispatching early", async () => {
  const f = fixture(); let checks = 0;
  const startup = new CocoStartup({ verify: async () => ++checks === 1 ? { ok: false, message: "Previous scheduler stopping" } : { ok: true }, blocked: message => f.engine.setBlocked(message), start: () => f.engine.start() }, 10000);
  try {
    await startup.run(); assert.equal(f.engine.snapshot().state, "blocked"); assert.equal(f.executed(), 0);
    assert.throws(() => f.engine.command({ type: "chat", text: "Do it" }), /Previous scheduler stopping/);
    await startup.run(); assert.equal(f.engine.snapshot().state, "idle");
    f.engine.command({ type: "chat", text: "Do it" }); await until(() => f.engine.snapshot().work[0]?.status === "completed"); assert.equal(f.executed(), 1);
  } finally { startup.stop(); await f.close(); }
});


test("obsolete CoCo permission and session settings cannot leave hidden restrictions",()=>{
  const settings=validateSettings({...defaultSettings(),fullPermissions:false,shellEnabled:false,shellAllowedDomains:["invalid://old"],mcpGrants:"obsolete",excludedSessionIds:["old-session"]});
  assert.equal(settings.fullPermissions,true);
  for(const key of ["shellEnabled","shellAllowedDomains","mcpGrants","excludedSessionIds"])assert.equal(Object.hasOwn(settings,key),false);
});

test("commander handles chat and steers merged requirements while one execution session runs", async () => {
  let release!: () => void, planned = 0, dispatched = 0, followed: CocoWork | undefined;
  const running = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({
    context: () => ({ workspaces: [{ id: "p1", name: "Project" }], sessions: [{ id: "existing", workspaceId: "p1", title: "Related implementation", status: "running", updatedAt: 1 }] }),
    model: async (purpose, input) => {
      if (purpose === "verify") return pass;
      const result = plan(++planned === 1 ? "Implement" : "Adjust implementation");
      const item = result.work[0]!;
      return { ...result, work: [{ ...item, executionSessionId: "existing", sessionStrategy: "steer", ...(planned === 2 ? { objective: "Also support keyboard navigation", acceptance: [{ id: "keyboard", kind: "review", description: "Keyboard navigation works" }] } : {}) }] };
    },
    execute: async (_work, _settings, _signal, _usage, attach) => { dispatched++; attach("existing"); await running; return { summary: "Finished revised implementation", evidence: {} }; },
    followup: async work => { followed = work; },
  });
  try {
    f.engine.start(); f.engine.command({ type: "chat", text: "Implement it" });
    await until(() => dispatched === 1);
    f.engine.command({ type: "chat", text: "Also support keyboard navigation" });
    await until(() => Boolean(followed));
    assert.equal(f.engine.snapshot().work.length, 1);
    assert.equal(dispatched, 1);
    assert.equal(followed!.sessionId, "existing");
    assert.equal(followed!.acceptance.length, 2);
    assert.equal(followed!.goalIds?.length, 2);
    assert.equal(followed!.revision, 2);
    release(); await until(() => f.engine.snapshot().work[0]?.status === "completed");
    assert.equal(f.engine.snapshot().verifications[0]?.revision, 2);
    assert.equal(f.engine.snapshot().verifications[0]?.checks.length, 1);
  } finally { release(); await f.close(); }
});

test("escalated executor questions keep selectable options on to_decide work", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({
    model: async purpose => purpose === "plan" ? plan() : purpose === "decide" ? { action: "needs_user", reason: "Product tradeoff" } : pass,
    execute: async (work, _settings, signal) => {
      await f.engine.ask(work.id, { question: "Ship the rewrite?", options: ["Keep the parser", "Rewrite it"], allowCustom: true }, signal);
      return { summary: "Needs a product call", waiting: "Ship the rewrite?\nProduct tradeoff", decisionPrompt: { question: "Ship the rewrite?", options: ["Keep the parser", "Rewrite it"], allowCustom: true }, evidence: {} };
    },
  });
  f.engine.start(); f.engine.command({ type: "chat", text: "Decide the parser" });
  await until(() => f.engine.snapshot().work[0]?.status === "to_decide");
  const work = f.engine.snapshot().work[0]!;
  assert.deepEqual(work.decisionPrompt?.options, ["Keep the parser", "Rewrite it"]);
  assert.equal(work.decisionPrompt?.question, "Ship the rewrite?");
  f.engine.command({ type: "work", id: work.id, action: "resume", answer: "Keep the parser" });
  assert.match(f.engine.snapshot().work[0]!.objective, /Keep the parser/);
  assert.equal(f.engine.snapshot().work[0]!.decisionPrompt, undefined);
  await f.close();
});
test("a user decision answers the parked ask_user and continues the same execution", async () => {
  let parked!: (answer: string | null) => void;
  const answer = new Promise<string | null>(resolve => { parked = resolve; });
  let runs = 0;
  let f: ReturnType<typeof fixture>;
  f = fixture({
    model: async purpose => purpose === "plan" ? plan() : pass,
    execute: async (work, _settings, signal) => {
      runs++;
      const picked = await f.engine.awaitWorkAnswer(work.id, "Ship it?", { question: "Ship it?", options: ["Yes", "No"], allowCustom: false }, signal);
      parked(picked);
      return { summary: "Continued after the decision", evidence: {} };
    },
  });
  f.engine.start();
  f.engine.command({ type: "chat", text: "Ship the report" });
  await until(() => f.engine.snapshot().work[0]?.status === "to_decide");
  const work = f.engine.snapshot().work[0]!;
  assert.deepEqual(work.decisionPrompt?.options, ["Yes", "No"]);
  assert.equal(work.decisionPrompt?.question, "Ship it?");
  const revision = work.revision;
  f.engine.command({ type: "work", id: work.id, action: "resume", answer: "Yes" });
  assert.equal(await answer, "Yes");
  await until(() => f.engine.snapshot().work[0]?.status === "completed");
  const done = f.engine.snapshot().work[0]!;
  assert.equal(runs, 1);
  assert.equal(done.revision, revision);
  assert.equal(done.objective.includes("User decision"), false);
  await f.close();
});

test("CoCo resolves an executor question without blocking on the execution slot", async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture({
    model: async purpose => purpose === "plan" ? plan() : purpose === "decide" ? { action: "answer", answer: "Reuse the existing parser", reason: "The saved objective requires minimal changes" } : pass,
    execute: async (work, _settings, signal) => {
      const result = await f.engine.ask(work.id, { question: "Which parser?" }, signal);
      assert.equal((result as { answer: string }).answer, "Reuse the existing parser");
      return { summary: "Applied CoCo's technical decision", evidence: {} };
    },
  });
  f.engine.start(); f.engine.command({ type: "chat", text: "Use minimal changes" });
  await until(() => f.engine.snapshot().work[0]?.status === "completed");
  assert.equal(f.engine.snapshot().work[0]?.decision, undefined); await f.close();
});

test("decisions use their own lane and the fast model while coordination is busy", async () => {
  let f: ReturnType<typeof fixture>, releaseReport!: () => void, decidedWith = "";
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  f = fixture({
    model: async purpose => { if (purpose === "report") { await reportGate; return { markdown: "# Report" }; } return purpose === "plan" ? plan() : pass; },
    decide: async (_input, _signal, _usage, providerId) => { decidedWith = providerId; return { action: "answer", answer: "Reuse the existing parser", reason: "Minimal change" }; },
    execute: async (work, _settings, signal) => {
      f.engine.command({ type: "report" }); await f.engine.tick();
      const result = await f.engine.ask(work.id, { question: "Which parser?", options: ["Reuse the existing parser", "Add one"] }, signal);
      assert.equal((result as { answer: string }).answer, "Reuse the existing parser");
      return { summary: "Applied", evidence: {} };
    },
  });
  f.repository.setMeta("settings", { ...defaultSettings(), enabled: true, providerId: "main", fastProviderId: "fast" });
  try {
    f.engine.start(); f.engine.command({ type: "chat", text: "Use minimal changes" });
    await until(() => f.engine.snapshot().work[0]?.status === "verifying" || f.engine.snapshot().work[0]?.status === "completed");
    assert.equal(decidedWith, "fast");
  } finally { releaseReport(); await f.close(); }
});

test("verification completes when the model says the task is done", async () => {
  let verifyCalls = 0;
  const f = fixture({ model: async purpose => { if (purpose === "verify") verifyCalls++; return purpose === "plan" ? plan() : pass; } });
  f.engine.start(); f.engine.command({ type: "chat", text: "Make tests pass" });
  await until(() => f.engine.snapshot().work[0]?.status === "completed");
  assert.equal(verifyCalls, 1); assert.equal(f.engine.snapshot().verifications[0]?.passed, true); assert.equal(f.executed(), 1); await f.close();
});

test("a continue decision advances the session with only the short prompt", async () => {
  let verifyCalls = 0;
  const seen: string[] = [];
  const f = fixture({
    model: async purpose => {
      if (purpose === "verify") { verifyCalls++; return verifyCalls === 1 ? { action: "continue", prompt: "Add the missing summary.", reason: "The report has no summary" } : pass; }
      return purpose === "plan" ? plan() : pass;
    },
    execute: async work => { if (work.advancePrompt) seen.push(work.advancePrompt); return { summary: "Turn ended", evidence: {} }; },
  });
  f.engine.start(); f.engine.command({ type: "chat", text: "Write the report" });
  await until(() => f.engine.snapshot().work[0]?.status === "completed");
  assert.deepEqual(seen, ["Add the missing summary."]);
  assert.equal(f.engine.snapshot().work[0]?.objective.includes("Add the missing summary"), false);
  assert.equal(verifyCalls, 2); await f.close();
});

test("a verification decision from the user becomes the next session prompt", async () => {
  let asked = false;
  const seen: string[] = [];
  const f = fixture({
    model: async purpose => {
      if (purpose === "verify" && !asked) { asked = true; return { action: "needs_user", question: "Which audience?", reason: "The audience changes the goal" }; }
      return purpose === "plan" ? plan() : pass;
    },
    execute: async work => { if (work.advancePrompt) seen.push(work.advancePrompt); return { summary: "Turn ended", evidence: {} }; },
  });
  f.engine.start(); f.engine.command({ type: "chat", text: "Write the report" });
  await until(() => f.engine.snapshot().work[0]?.status === "to_decide");
  const work = f.engine.snapshot().work[0]!;
  f.engine.command({ type: "work", id: work.id, action: "resume", answer: "Internal users" });
  await until(() => f.engine.snapshot().work[0]?.status === "completed");
  assert.deepEqual(seen, ["Internal users"]);
  assert.equal(f.engine.snapshot().work[0]?.objective.includes("User decision"), false);
  assert.equal(f.engine.snapshot().work[0]?.revision, work.revision); await f.close();
});

test("session reuse falls back to a new session for stale targets and rejects cross-project targets", () => {
  const result = { ...plan(), work: [{ ...plan().work[0]!, executionSessionId: "s1", sessionStrategy: "steer" }] };
  const stale = validatePlan(result, new Set(["p1"]), new Set(), new Set(), new Map()).work[0]!;
  assert.equal(stale.executionSessionId, undefined);
  assert.equal(stale.sessionStrategy, undefined);
  assert.throws(() => validatePlan(result, new Set(["p1"]), new Set(["s1"]), new Set(), new Map([["s1", "p2"]])), /different project/);
});

test("manual chat remains responsive during background planning and automation cooldown", async () => {
  let releasePlan!:()=>void, replies=0;
  const planning=new Promise<void>(resolve=>{releasePlan=resolve;});
  const f=fixture({conversation:async(request,callbacks,_signal,usage)=>{replies++;usage(40,false,`manual-${replies}`);callbacks.publish(`Answer: ${request.request}`,"completed");},model:async purpose=>{if(purpose==="plan"){await planning;return {...plan(),work:[]};}return pass;}});
  f.repository.put("rule",rule(0));f.engine.start();f.engine.command({type:"rule",action:"run",id:"r1"});
  await until(()=>f.engine.snapshot().planningJob?.kind==="inspect");
  f.engine.command({type:"chat",text:"Can we discuss the goal?"});await until(()=>replies===1&&!f.engine.snapshot().chatJob);
  assert.equal(f.engine.snapshot().planningJob?.kind,"inspect","the same background planning turn is still active");
  releasePlan();await until(()=>!f.engine.snapshot().planningJob);
  f.engine.budget.record({id:"automatic-cap",purpose:"execute",tokens:200000,estimated:false});
  assert.equal(f.engine.snapshot().state,"cooldown");
  f.engine.command({type:"chat",text:"What are you waiting for?"});await until(()=>replies===2&&!f.engine.snapshot().chatJob);
  assert.equal(f.engine.snapshot().state,"cooldown");assert.equal(f.engine.snapshot().budget.hourly,200080,"interactive chat usage is counted toward the shared hourly budget");
  await f.close();
});

test("a task starts while CoCo is still replying, and chat does not force it to yield", async () => {
  let releaseChat!:()=>void, releaseTask!:()=>void, executions=0;
  const chatting=new Promise<void>(resolve=>{releaseChat=resolve;}),running=new Promise<void>(resolve=>{releaseTask=resolve;});
  const f=fixture({conversation:async(_input,callbacks)=>{callbacks.commit(plan());callbacks.publish("The saved task can start while we discuss it.","streaming");await chatting;callbacks.publish("We can keep discussing the goal.","completed");},execute:async()=>{executions++;await running;return {summary:"Done",evidence:{}};}});
  try{
    f.engine.start();f.engine.command({type:"chat",text:"Start this and discuss it with me."});
    await until(()=>executions===1);
    assert.ok(f.engine.snapshot().chatJob);assert.equal(f.engine.snapshot().executionJob?.kind,"execute");
    assert.equal(f.engine.canContinueWork(f.engine.snapshot().work[0]!.id),true,"an active conversation does not preempt the task");
    releaseChat();releaseTask();await until(()=>f.engine.snapshot().work[0]?.status==="completed");
  }finally{releaseChat();releaseTask();await f.close();}
});

test("automatic task recovery reuses its session after a bounded backoff",async()=>{
  let attempts=0,reviews=0;
  const f=fixture({execute:async(work,_settings,_signal,_usage,attach)=>{attempts++;attach(work.sessionId??"original-session");return attempts===1?{summary:"Connection lost",interrupted:"Provider connection reset",evidence:{}}:{summary:"Continued from saved progress",evidence:{}};},recover:async work=>{reviews++;assert.equal(work.sessionId,"original-session");return {action:"resume",summary:"No uncertain tool effect; continue the saved session",turnId:"failed-turn"};}});
  f.engine.start();f.engine.command({type:"chat",text:"Implement the goal."});await until(()=>f.engine.snapshot().work[0]?.status==="recovering");
  assert.equal(attempts,1);await f.engine.tick();assert.equal(reviews,0,"recovery does not busy-loop");
  f.advance(1000);await f.engine.tick();await until(()=>f.engine.snapshot().work[0]?.status==="completed");
  assert.equal(attempts,2);assert.equal(reviews,1);assert.equal(f.engine.snapshot().work[0]?.sessionId,"original-session");await f.close();
});

test("repeated session failures stop automatic recovery after three attempts",async()=>{
  let attempts=0;
  const f=fixture({execute:async(_w,_s,_signal,_usage,attach)=>{attempts++;attach("same-session");return {summary:"Disconnected",interrupted:"Still disconnected",evidence:{}};},recover:async()=>({action:"resume",summary:"Try the saved session",turnId:"last-turn"})});
  f.engine.start();f.engine.command({type:"chat",text:"Do the task."});await until(()=>f.engine.snapshot().work[0]?.status==="recovering");
  for(let i=1;i<=3;i++){f.advance(30000);await f.engine.tick();await until(()=>attempts===i+1&&["recovering","to_decide"].includes(f.engine.snapshot().work[0]?.status??""));}
  assert.equal(attempts,4);assert.equal(f.engine.snapshot().work[0]?.status,"to_decide");assert.match(f.engine.snapshot().work[0]?.summary??"",/recovery limit/);await f.close();
});

test("reopening after three interrupted recovery checks requires review without a fourth model request",async()=>{
  let reviews=0;
  const f=fixture({recover:async()=>{reviews++;return {action:"resume",summary:"Continue"};}});
  const at=f.time();
  f.repository.put<CocoWork>("work",{id:"exhausted-work",goalId:"goal",workspaceId:"p1",title:"Saved work",objective:"Finish the saved output",status:"recovering",priority:50,dependsOn:[],steps:[],acceptance:[],deliverables:[],ruleIds:[],revision:1,repairs:0,fullPermissions:true,providerId:"",sessionId:"saved-session",recoveryAttempts:3,createdAt:at,updatedAt:at,summary:"Previous check interrupted",timeline:[]});
  try{f.engine.start();await until(()=>f.engine.snapshot().work[0]?.status==="to_decide");assert.equal(reviews,0);assert.match(f.engine.snapshot().work[0]!.summary,/recovery limit/);}finally{await f.close();}
});

test("disabled CoCo rejects chat without creating a message or starting work",async()=>{
  let answered=false;
  const f=fixture({conversation:async()=>{answered=true;}});
  try {
    f.engine.start(); f.engine.command({type:"settings",settings:{...defaultSettings(),enabled:false}});
    assert.throws(()=>f.engine.command({type:"chat",text:"Discuss the plan."}),/Enable CoCo/);
    await f.engine.tick(); assert.equal(answered,false); assert.equal(f.engine.snapshot().messages.length,0);
    assert.equal(f.engine.snapshot().state,"paused"); assert.equal(f.executed(),0);
  } finally { await f.close(); }
});

test("context capacity errors automatically retry verification without a decision or execution replay",async()=>{
  let checks=0,notifications=0;
  const f=fixture({model:async purpose=>{if(purpose==="plan")return plan();if(++checks===1)throw new CocoContextCapacityError();return pass;},notify:()=>{notifications++;}});
  try{
    f.engine.start();f.engine.command({type:"chat",text:"Complete the task."});
    await until(()=>f.repository.pending<{contextRetries?:number}>("job").some(j=>j.contextRetries===1));
    assert.equal(f.engine.snapshot().work[0]?.status,"verifying");assert.equal(notifications,0);assert.equal(f.executed(),1);
    await f.engine.tick();assert.equal(checks,1,"capacity retries back off instead of busy-looping");
    f.advance(30000);await f.engine.tick();await until(()=>f.engine.snapshot().work[0]?.status==="completed");
    assert.equal(f.executed(),1,"only verification is retried");assert.equal(f.engine.snapshot().work[0]?.decision,undefined);
  }finally{await f.close();}
});

test("startup repairs a legacy context-limit decision by resuming acceptance",async()=>{
  const f=fixture();
  f.repository.put("work",{id:"saved",goalId:"goal",title:"Saved result",objective:"Review the saved result",workspaceId:"p1",status:"to_decide",priority:50,dependsOn:[],steps:[],acceptance:[{id:"c1",kind:"review",description:"Saved evidence confirms completion"}],deliverables:[],ruleIds:[],revision:1,repairs:0,fullPermissions:true,providerId:"",createdAt:0,updatedAt:0,summary:"CoCo context is too large; narrow the project scope",decision:"CoCo context is too large; narrow the project scope",timeline:[]});
  f.repository.put("job",{id:"old-verification",workId:"saved",kind:"verify",status:"done",at:0,priority:50});
  try{f.engine.start();await until(()=>f.engine.snapshot().work[0]?.status==="completed");assert.equal(f.executed(),0);assert.equal(f.engine.snapshot().work[0]?.decision,undefined);}finally{await f.close();}
});

test("delegated rules activate immediately; previews remain explicit drafts", async () => {
  for (const draft of [false, true]) {
    const f = fixture({ model: async () => ({ ...plan(), work: [], planOnly: draft, ruleSuggestions: [{ ...rule(0), enabled: true }] }) });
    try {
      f.engine.start(); f.engine.command({ type: "chat", text: draft ? "Preview these rules only" : "Keep following this goal" });
      await until(() => f.engine.snapshot().rules.length === 1);
      const saved = f.engine.snapshot().rules[0]!;
      assert.equal(saved.confirmed, !draft); assert.equal(saved.enabled, !draft);
      assert.equal(saved.draftOnly, draft); assert.equal(saved.origin, "coco");
      assert.equal(saved.nextRunAt > f.time(), !draft);
    } finally { await f.close(); }
  }
});

type AutonomousInput = { autonomous?: { briefing: string }; wake?: unknown; request: string };
/** Conversation port: chat requests commit `planFor(request)`; automatic turns are recorded. */
const conversationSpy = (inputs: AutonomousInput[], options: { planFor?: (request: string) => unknown; completed?: () => boolean } = {}): CocoPorts["conversation"] => async (input, callbacks) => {
  inputs.push(input as AutonomousInput);
  if (!input.autonomous && !input.wake && options.planFor) callbacks.commit(options.planFor(input.request));
  callbacks.publish(input.autonomous ? "Here is where things stand." : "Done.", "completed", { id: `m${inputs.length}`, at: 1 });
  return { completed: options.completed?.() ?? true };
};
const heartbeat = (f: ReturnType<typeof fixture>, minutes = 15) => f.repository.setMeta("settings", { ...defaultSettings(), enabled: true, heartbeatMinutes: minutes });
const briefings = (inputs: AutonomousInput[]) => inputs.flatMap(i => i.autonomous ? [i.autonomous.briefing] : []);

test("a heartbeat without recorded changes skips the model and offers one small talk", async () => {
  const purposes: string[] = [];
  const f = fixture({ model: async purpose => { purposes.push(purpose); return purpose === "greet" ? { markdown: "Quiet evening so far." } : pass; } });
  try {
    heartbeat(f);
    f.repository.put("message", { id: "old", role: "user", text: "Follow the existing report", at: f.time() - 2 * 3600000 });
    f.engine.start(); f.advance(15 * 60000); await f.engine.tick(); await until(() => purposes.length === 1); await f.engine.settled();
    assert.deepEqual(purposes, ["greet"], "nothing changed: no autonomous turn");
    assert.equal(f.engine.snapshot().messages.at(-1)?.text, "Quiet evening so far.");
    f.advance(2 * 3600000); await f.engine.tick(); await f.engine.settled();
    assert.deepEqual(purposes, ["greet"], "an unanswered remark is not followed by another");
  } finally { await f.close(); }
});

test("heartbeat version reads: first sight is a baseline, a moved commit wakes once with short hashes", async () => {
  const inputs: AutonomousInput[] = [];
  let head = { kind: "git" as const, ref: "refs/heads/main", commit: "a".repeat(40) }, reads = 0;
  const f = fixture({
    context: () => ({ workspaces: [{ id: "p1", name: "Project", path: "/work/project" }], sessions: [] }),
    conversation: conversationSpy(inputs),
    vcs: async () => { reads++; return { p1: head }; },
  });
  try {
    heartbeat(f);
    f.engine.start(); f.advance(15 * 60000); await f.engine.tick(); await until(() => reads === 1); await f.engine.settled();
    assert.equal(briefings(inputs).length, 0, "first sight only records the baseline");
    head = { ...head, ref: "refs/heads/feature" };
    f.advance(15 * 60000); await f.engine.tick(); await until(() => reads === 2); await f.engine.settled();
    assert.equal(briefings(inputs).length, 0, "a branch switch on the same commit is not reported");
    head = { ...head, ref: "refs/heads/main", commit: "b".repeat(40) };
    f.advance(15 * 60000); await f.engine.tick(); await until(() => briefings(inputs).length === 1); await f.engine.settled();
    const briefing = briefings(inputs)[0]!;
    assert.match(briefing, /^\[Automatic CoCo wake, not a user message\]/);
    assert.match(briefing, /Wake: heartbeat/);
    assert.match(briefing, /- Project — \/work\/project\n {2}- git main: aaaaaaa → bbbbbbb/);
    f.advance(15 * 60000); await f.engine.tick(); await f.engine.settled();
    assert.equal(briefings(inputs).length, 1, "the delivered version becomes the new baseline");
  } finally { await f.close(); }
});

test("task outcomes coalesce into one wake; a failed autonomous turn redelivers them", async () => {
  const inputs: AutonomousInput[] = [];
  let sequence = 0, succeed = false;
  const f = fixture({ conversation: conversationSpy(inputs, { planFor: () => plan(`Task ${++sequence}`, `t${sequence}`), completed: () => succeed }) });
  try {
    f.engine.start();
    f.engine.command({ type: "chat", text: "One", workspaceId: "p1" });
    f.engine.command({ type: "chat", text: "Two", workspaceId: "p1" });
    await until(() => f.engine.snapshot().work.filter(w => w.status === "completed").length === 2);
    f.advance(3000); await f.engine.tick(); await until(() => briefings(inputs).length === 1); await f.engine.settled();
    const first = briefings(inputs)[0]!;
    assert.match(first, /Wake: task completed\n/);
    assert.match(first, /Tasks\n- Task 1 — completed · \S+ \(workspaceId p1, workId [^)]+\)\n- Task 2 — completed · /);
    succeed = true;
    f.engine.command({ type: "settings", settings: { ...defaultSettings(), enabled: true, heartbeatMinutes: 1 } });
    f.advance(60000); await f.engine.tick(); await until(() => briefings(inputs).length === 2); await f.engine.settled();
    assert.match(briefings(inputs)[1]!, /Wake: heartbeat, task completed/, "undelivered entries ride the next heartbeat");
    f.advance(60000); await f.engine.tick(); await f.engine.settled();
    assert.equal(briefings(inputs).length, 2, "delivered entries are not repeated");
  } finally { await f.close(); }
});

test("user pause and cancel are not ledgered; a disabled CoCo records nothing", async () => {
  const f = fixture({ execute: async (_w, _s, signal) => { await new Promise(resolve => signal.addEventListener("abort", resolve)); return { summary: "Stopped", evidence: {} }; } });
  try {
    f.engine.start(); f.engine.command({ type: "chat", text: "Long task", workspaceId: "p1" });
    await until(() => f.engine.snapshot().work[0]?.status === "executing");
    const id = f.engine.snapshot().work[0]!.id;
    f.engine.command({ type: "work", id, action: "pause" }); await f.engine.settled();
    f.engine.command({ type: "work", id, action: "cancel" }); await f.engine.settled();
    assert.equal(f.repository.list("wakeEntry").length, 0);
    f.engine.command({ type: "settings", settings: { ...defaultSettings(), enabled: false } });
    f.engine.recordWake({ kind: "workspace_added", workspaceId: "p2", workspaceName: "Two", workspacePath: "/two" }, true);
    assert.equal(f.repository.list("wakeEntry").length, 0);
  } finally { await f.close(); }
});

test("closing with a running task wakes CoCo after restart with an app-restart interruption", async () => {
  const inputs: AutonomousInput[] = [];
  const f = fixture({
    conversation: conversationSpy(inputs, { planFor: () => plan("Long task", "long") }),
    execute: async (_w, _s, signal, _u, attach) => { attach("live"); await new Promise(resolve => signal.addEventListener("abort", resolve)); throw new Error("aborted"); },
    recover: async () => ({ action: "wait", summary: "Waiting for review" }),
  });
  try {
    f.engine.start(); f.engine.command({ type: "chat", text: "Long task", workspaceId: "p1" });
    await until(() => f.engine.snapshot().work[0]?.status === "executing");
    f.engine.stop(); await f.engine.settled();
    f.engine.start(); f.advance(3000); await f.engine.tick();
    await until(() => briefings(inputs).length === 1); await f.engine.settled();
    assert.match(briefings(inputs)[0]!, /Wake: app restart/);
    assert.match(briefings(inputs)[0]!, /- Long task — interrupted \(app restart\)/);
  } finally { await f.close(); }
});

test("a user message during an autonomous turn waits for it instead of aborting it", async () => {
  const inputs: AutonomousInput[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ conversation: async (input, callbacks) => {
    inputs.push(input as AutonomousInput);
    if (input.autonomous) await gate;
    callbacks.publish(input.autonomous ? "Follow-up done." : "Hello back.", "completed", { id: `m${inputs.length}`, at: 1 });
  } });
  try {
    f.engine.start();
    f.engine.recordWake({ kind: "workspace_added", workspaceId: "p1", workspaceName: "Project", workspacePath: "/work/project" }, true);
    f.advance(3000); void f.engine.tick(); await until(() => inputs.length === 1);
    f.engine.command({ type: "chat", text: "Hello" }); void f.engine.tick(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(inputs.length, 1, "chat queues behind the autonomous turn");
    assert.equal(f.engine.snapshot().chatJob?.kind, "autonomous");
    release(); await until(() => inputs.length === 2); await f.engine.settled();
    assert.equal(inputs[1]!.request, "Hello");
    assert.ok(f.engine.snapshot().messages.some(m => m.text === "Follow-up done."));
    assert.match(inputs[0]!.autonomous!.briefing, /Workspaces\n- Added: Project — \/work\/project/);
  } finally { release(); await f.close(); }
});

test("no autonomous wake while automation is cooling down", async () => {
  const inputs: AutonomousInput[] = [];
  const f = fixture({ conversation: conversationSpy(inputs) });
  try {
    f.repository.setMeta("settings", { ...defaultSettings(), enabled: true, hourlyTokens: 1, heartbeatMinutes: 240 });
    f.repository.put("usage", { id: "spent", at: f.time(), tokens: 1, purpose: "execute", estimated: false });
    f.engine.start();
    f.engine.recordWake({ kind: "workspace_added", workspaceId: "p1", workspaceName: "Project", workspacePath: "/p" }, true);
    f.advance(3000); await f.engine.tick(); await f.engine.settled();
    assert.equal(inputs.length, 0);
    assert.equal(f.repository.list<{ deliveredAt?: number }>("wakeEntry").filter(e => !e.deliveredAt).length, 1, "the entry waits for the window");
  } finally { await f.close(); }
});

test("a visit reports real active work without interrupting it or inventing a user turn", async () => {
  let release!: () => void, entered = false, greetingInput: any;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const notices: string[] = [];
  const f = fixture({
    chatState: () => ({ sessionId: "commander", status: "idle" }),
    notice: (_id, text) => notices.push(text),
    model: async (purpose, input) => {
      if (purpose === "greet") { greetingInput = input; return { markdown: "The report is being written. The review is finished." }; }
      return purpose === "plan" ? plan() : pass;
    },
    execute: async (_work, _settings, _signal, _usage, attach) => { entered = true; attach("active"); await gate; return { summary: "Written", evidence: {} }; },
  });
  try {
    f.engine.start(); f.engine.command({ type: "chat", text: "Write the report" }); await until(() => entered);
    f.advance(120000); await f.engine.tick();
    const work = f.engine.snapshot().work[0]!; f.repository.put("work", { ...work, updatedAt: f.time(), summary: "Review finished; writing the report" });
    f.engine.command({ type: "wake" }); await until(() => Boolean(greetingInput)); await until(() => notices.length === 1);
    assert.equal(greetingInput.work[0].status, "executing");
    assert.equal(f.engine.snapshot().work[0]?.status, "executing");
    assert.equal(f.engine.snapshot().messages.filter(m => m.role === "user").length, 1);
    f.engine.command({ type: "wake" }); assert.equal(notices.length, 1, "rapid re-entry is coalesced");
    release(); await until(() => f.engine.snapshot().work[0]?.status === "completed");
  } finally { release(); await f.close(); }
});

test("idle visits use small talk and an incoming user message cancels an obsolete greeting", async () => {
  let release!: () => void, started = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ model: async purpose => {
    if (purpose === "greet") { started = true; await gate; return { markdown: "Stale greeting" }; }
    return { reply: "Let's talk.", work: [] };
  } });
  try {
    f.engine.start(); f.engine.command({ type: "wake" }); await until(() => started);
    f.engine.command({ type: "chat", text: "Hello" }); release();
    await until(() => f.engine.snapshot().messages.some(m => m.text === "Let's talk."));
    assert.ok(!f.engine.snapshot().messages.some(m => m.text === "Stale greeting"));
    assert.equal(f.engine.snapshot().work.length, 0);
  } finally { release(); await f.close(); }
});

test("visits during cooldown stay conversational without spending automation tokens", async () => {
  let calls = 0;
  const f = fixture({ model: async () => { calls++; return {}; } });
  try {
    f.repository.setMeta("settings", { ...defaultSettings(), enabled: true, hourlyTokens: 1 });
    f.repository.put("usage", { id: "spent", purpose: "execute", tokens: 1, at: f.time(), estimated: false });
    f.engine.start(); f.engine.command({ type: "wake" }); await f.engine.settled();
    assert.equal(calls, 0); assert.match(f.engine.snapshot().messages.at(-1)?.text ?? "", /budget to reset/);
    assert.equal(f.engine.snapshot().messages.filter(m => m.role === "user").length, 0);
  } finally { await f.close(); }
});

test("inspection never recreates explicitly stopped work or changes existing goals", async () => {
  const f = fixture({
    context: () => ({ workspaces: [{ id: "p1", name: "Project" }], sessions: [{ id: "stopped", workspaceId: "p1", title: "Stopped", status: "paused", updatedAt: 1 }] }),
    model: async () => ({ ...plan(), work: [{ ...plan().work[0], executionSessionId: "stopped", sessionStrategy: "continue" }] }),
  });
  try {
    f.repository.put("rule", rule(f.time() + 60000));
    f.engine.start(); f.engine.command({ type: "rule", action: "run", id: "r1" }); await f.engine.settled();
    assert.equal(f.engine.snapshot().work.length, 0); assert.equal(f.executed(), 0);
  } finally { await f.close(); }
});

test("automatic rules inherit their source scope and repeated suggestions preserve a user's pause", async () => {
  const f = fixture({ model: async () => ({ reply: "Follow-up scheduled", work: [], ruleSuggestions: [{ ...rule(0), name: "Follow-up", objective: "Check the original delegated result", enabled: true, scope: { all: true, workspaceIds: [], excludedWorkspaceIds: [] } }] }) });
  try {
    f.repository.put("rule", { ...rule(0), scope: { all: false, workspaceIds: ["p1"], excludedWorkspaceIds: ["excluded"] } });
    f.engine.start(); f.engine.command({ type: "rule", action: "run", id: "r1" });
    await until(() => f.engine.snapshot().rules.length === 2); await f.engine.settled();
    const child = f.engine.snapshot().rules.find(r => r.id !== "r1")!;
    assert.deepEqual(child.scope, { all: false, workspaceIds: ["p1"], excludedWorkspaceIds: ["excluded"] });
    f.engine.command({ type: "rule", action: "toggle", id: child.id });
    f.engine.command({ type: "rule", action: "run", id: "r1" }); await f.engine.settled();
    assert.equal(f.engine.snapshot().rules.length, 2); assert.equal(f.engine.snapshot().rules.find(r => r.id === child.id)?.enabled, false);
  } finally { await f.close(); }
});

test("a stale visit greeting is discarded on restart instead of replayed in the background", async () => {
  let calls = 0;
  const f = fixture({ model: async () => { calls++; return { markdown: "Hello" }; } });
  try {
    f.repository.put("job", { id: "old-greeting", kind: "greet", status: "running", at: f.time() - 10000, priority: 0 });
    f.engine.start(); await f.engine.settled();
    assert.equal(calls, 0); assert.equal(f.repository.get<{ status: string }>("job", "old-greeting")?.status, "done");
  } finally { await f.close(); }
});

test("repeated idle visits stay silent without model calls, including after restart", async () => {
  let greetings = 0;
  const f = fixture({ model: async () => { greetings++; return { markdown: "How has your day been?" }; } });
  try {
    f.engine.start(); f.engine.command({ type: "wake" }); await until(() => greetings === 1); await f.engine.settled();
    for (const elapsed of [120000, 600000]) {
      f.advance(elapsed); await f.engine.tick(); f.engine.command({ type: "wake" }); await f.engine.settled();
    }
    assert.equal(greetings, 1);
    f.engine.stop(); await f.engine.settled(); f.engine.start();
    f.engine.command({ type: "wake" }); await f.engine.settled(); assert.equal(greetings, 1);
    f.advance(3600000); await f.engine.tick(); f.engine.command({ type: "wake" }); await f.engine.settled();
    assert.equal(greetings, 2);
  } finally { await f.close(); }
});

test("a visit stays a greeting even with recorded changes; autonomous turns come from the ledger", async () => {
  const inputs: AutonomousInput[] = [];
  const f = fixture({ conversation: conversationSpy(inputs) });
  try {
    f.engine.start();
    f.engine.recordWake({ kind: "project_doc", workspaceId: "p1", workspaceName: "Project", workspacePath: "/p", doc: "WORKLOG.md" }, false);
    f.engine.command({ type: "wake" });
    await until(() => inputs.length === 1); await f.engine.settled();
    assert.ok(inputs[0]!.wake && !inputs[0]!.autonomous, "visits keep the cheap greeting");
    f.advance(3000); await f.engine.tick(); await f.engine.settled();
    assert.equal(inputs.length, 1, "a document change waits for the heartbeat");
  } finally { await f.close(); }
});

test("project awareness publishes its notices without starting an autonomous turn", async () => {
  const inputs: AutonomousInput[] = [];
  let pending = true, runs = 0;
  const f = fixture({
    conversation: conversationSpy(inputs),
    project: { pending: () => pending, run: async () => { runs++; pending = false; return { notices: ["**New project added**"], changed: ["Project"] }; } },
  });
  try {
    f.engine.start();
    await until(() => runs === 1); await f.engine.settled();
    assert.ok(f.engine.snapshot().messages.some(m => m.text === "**New project added**"));
    assert.equal(inputs.length, 0);
  } finally { await f.close(); }
});

test("full autonomy: an autonomous wake starts new work on its own, but rules stay drafts", async () => {
  let committed: { drafted: number } | void = undefined;
  const suggestion = { name: "Nightly scan", objective: "Scan for regressions", mode: "inspection", scope: { all: true, workspaceIds: [], excludedWorkspaceIds: [] }, enabled: true, cadence: { kind: "minute", n: 15 }, fullPermissions: true, providerId: "", acceptance: [] };
  const f = fixture({
    conversation: async (input, callbacks) => {
      if (input.autonomous) committed = callbacks.commit({ ...plan("Fix errors", "fix"), ruleSuggestions: [suggestion] });
      callbacks.publish("Saved for your approval.", "completed", { id: "m1", at: 1 });
    },
  });
  try {
    f.engine.start();
    f.engine.recordWake({ kind: "workspace_added", workspaceId: "p1", workspaceName: "Project", workspacePath: "/p" }, true);
    f.advance(3000); await f.engine.tick();
    await until(() => committed !== undefined); await f.engine.settled();
    assert.deepEqual(committed, { drafted: 0 });
    await until(() => f.engine.snapshot().work[0]?.status === "completed");
    assert.ok(f.executed() >= 1, "autonomous work is dispatched without Start work");
    const created = f.repository.list<CocoRule>("rule");
    assert.equal(created.length, 1);
    assert.ok(created[0]!.draftOnly && !created[0]!.confirmed && !created[0]!.enabled, "autonomous rules stay unconfirmed drafts");
  } finally { await f.close(); }
});

test("Chat can update, pause, resume and delete an existing rule", async () => {
  const results: unknown[] = [];
  let changes: unknown[] = [];
  const f = fixture({ conversation: async (_input, callbacks) => {
    for (const change of changes) results.push(callbacks.rule!(change));
    callbacks.publish("Done.", "completed", { id: `m${results.length}`, at: 1 });
  } });
  try {
    f.repository.put("rule", { ...rule(f.time() + 3600000), name: "Weekly scan" });
    f.engine.start();
    const say = async (text: string, next: unknown[]) => { changes = next; const before = results.length; f.engine.command({ type: "chat", text }); await until(() => results.length === before + next.length); await f.engine.settled(); };
    await say("Move the scan to 09:30 daily", [{ action: "update", ruleId: "r1", rule: { cadence: { kind: "day", time: "09:30" }, name: "Daily scan" } }]);
    let saved = f.repository.get<CocoRule>("rule", "r1")!;
    assert.deepEqual(saved.cadence, { kind: "day", time: "09:30" });
    assert.equal(saved.name, "Daily scan");
    assert.equal(saved.objective, "Find real work", "omitted fields are kept");
    await say("Pause it", [{ action: "pause", ruleId: "r1" }]);
    assert.equal(f.repository.get<CocoRule>("rule", "r1")!.enabled, false);
    await say("Resume it", [{ action: "resume", ruleId: "r1" }]);
    saved = f.repository.get<CocoRule>("rule", "r1")!;
    assert.equal(saved.enabled, true);
    await say("Delete it", [{ action: "delete", ruleId: "r1" }]);
    assert.equal(f.repository.get("rule", "r1"), undefined);
    assert.deepEqual(results.at(-1), { id: "r1", name: "Daily scan", deleted: true });
  } finally { await f.close(); }
});

test("Chat rule changes accept an id nested in the patch and explain a wrong ruleId", async () => {
  const results: unknown[] = [];
  let changes: unknown[] = [];
  const f = fixture({ conversation: async (_input, callbacks) => {
    for (const change of changes) { try { results.push(callbacks.rule!(change)); } catch (error) { results.push((error as Error).message); } }
    callbacks.publish("Done.", "completed", { id: `m${results.length}`, at: 1 });
  } });
  try {
    f.repository.put("rule", { ...rule(f.time() + 3600000), name: "Weekly scan" });
    f.engine.start();
    const say = async (text: string, next: unknown[]) => { changes = next; const before = results.length; f.engine.command({ type: "chat", text }); await until(() => results.length === before + next.length); await f.engine.settled(); };
    await say("Shorten it", [{ action: "update", rule: { ruleId: "r1", objective: "Nested ruleId" } }]);
    assert.equal(f.repository.get<CocoRule>("rule", "r1")!.objective, "Nested ruleId");
    await say("Shorten again", [{ action: "update", rule: { id: "r1", objective: "Nested id" } }]);
    assert.equal(f.repository.get<CocoRule>("rule", "r1")!.objective, "Nested id");
    await say("By name", [{ action: "update", ruleId: "weekly scan", rule: { objective: "x" } }, { action: "update", rule: { objective: "x" } }, { action: "pause", ruleId: "nope" }]);
    assert.match(String(results.at(-3)), /not its name: use ruleId "r1"/);
    assert.match(String(results.at(-2)), /Missing ruleId: .*top-level/);
    assert.match(String(results.at(-1)), /Unknown ruleId "nope"/);
    assert.equal(f.repository.get<CocoRule>("rule", "r1")!.objective, "Nested id", "rejected changes leave the rule untouched");
  } finally { await f.close(); }
});
