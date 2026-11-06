import { SMALL_TALK_INTERVAL, visitWake, type VisitState } from "./visitWake.js";
import { isContextCapacityError } from "./contextErrors.js";
import { randomUUID, createHash } from "node:crypto";
import { verifyDecision } from "./verifyDecision.js";
import { nextRunAt } from "../loops/schedule.js";
import { CocoRepository } from "./repository.js";
import { defaultSettings, validatePlan, validateRule, validateSettings } from "./validation.js";
import { inCocoScope, ruleAuthorizes } from "./scope.js";
import { decisionPromptFor, type CocoDecisionPrompt } from "./decisionPrompt.js";
import { isActiveWork, isTerminalWork, occupiesWorkspace, workRank } from "./status.js";
import { CocoBudgetManager, windowKeys } from "./budgetManager.js";
import { clipTimeline, wakeBackgroundTasks } from "./contextBudget.js";
import { chatRuns, recentRuns } from "./ruleRuns.js";
import { cocoActivity, type CocoActivity, type CocoActivityInput } from "./activity.js";
import { appendWakeEntry, formatWakeBriefing, markWakeEntriesDelivered, nextVcsBaseline, pruneWakeEntries, seedVcsBaseline, undeliveredWakeEntries, vcsChanges, wakeReasons, type CocoProjectDocNote, type CocoWakeProject } from "./wakeLedger.js";
import type { CocoAttempt, CocoRuleRun, CocoCommand, CocoGoalPlan, CocoJob, CocoMessage, CocoMcpEvent, CocoReport, CocoRule, CocoSettings, CocoSnapshot, CocoVcsFact, CocoVerification, CocoWakeEntry, CocoWork, CocoToolApproval, CocoSnapshot as Snapshot } from "./types.js";

export type CocoContext = { workspaces: { id: string; name: string; path?: string }[]; sessions: { id: string; workspaceId: string; title: string; status: string; updatedAt: number }[]; changes?: unknown; /** Recent MCP notifications (minimal visibility, "see, don't act"; see cocoService context builder). */ mcpEvents?: CocoMcpEvent[] };
export type CocoConversationCallbacks = {
  plan(input: unknown): { requestId: string; queued: boolean };
  /** `drafted`: new work items saved as drafts instead of being queued. */
  commit(plan: unknown): { drafted: number } | void;
  /** Change an existing rule (Chat only): update | pause | resume | delete. */
  rule?(change: unknown): unknown;
  publish(text: string, status: NonNullable<CocoMessage["status"]>, source?: { id: string; at: number }): void;
};
export type CocoRecoveryResult = { action: "resume" | "verify" | "wait" | "needs_user"; summary: string; turnId?: string | undefined; uncertainEffects?: boolean | undefined };
export type CocoPorts = {
  recover?(work: CocoWork, settings: CocoSettings, signal: AbortSignal, usage: (tokens: number, estimated: boolean, requestId: string) => void): Promise<CocoRecoveryResult>;
  /** Resolves `{ completed: false }` when the turn stopped or failed; void counts as completed. */
  conversation?(input: { wake?: Record<string, unknown>; autonomous?: { briefing: string }; handoverInstruction?: string | undefined; request: string; reference?: CocoWork | undefined; context: CocoContext; existingWork: CocoWork[]; planOnly: boolean; preferredWorkspaceId?: string | undefined; history?: CocoMessage[]; continuation?: "retry" | undefined }, callbacks: CocoConversationCallbacks, signal: AbortSignal, usage: (tokens: number, estimated: boolean, requestId: string) => void, providerId: string): Promise<void | { completed: boolean }>;
  /** Current Git/SVN version per project (null = no repository or unreadable). Read at heartbeat and wake time only. */
  vcs?(projects: CocoWakeProject[]): Promise<Record<string, CocoVcsFact | null>>;
  /** What the PROJECT.md digest did after a ledgered write, if it has run yet. */
  projectDocNote?(entry: CocoWakeEntry): CocoProjectDocNote | undefined;
  resetAutonomousPrompt?(): void;
  /** CoCo was enabled or its project scope changed. */
  scopeChanged?(): void;
  chatState?(): CocoSnapshot["chat"];
  /** Cheap subset of `chatState` for activity; falls back to `chatState`. */
  chatStatus?(): CocoActivityInput["chat"];
  backgroundTasks?(): NonNullable<CocoSnapshot["backgroundTasks"]>;
  chatControl?(command: Extract<CocoCommand, { type: "chatControl" }>): void;
  settingsOptions?(): { workspaceOptions: { id: string; name: string }[]; mcpOptions?: NonNullable<Snapshot["mcpOptions"]> };
  cleanup?(settings:CocoSettings,signal:AbortSignal,usage:(tokens:number,estimated:boolean,requestId:string)=>void):Promise<void>;
  context(settings: CocoSettings, rule?: CocoRule): CocoContext;
  model(purpose: string, input: unknown, signal: AbortSignal, usage: (tokens: number, estimated: boolean, requestId: string) => void, providerId: string, operationId?: string): Promise<unknown>;
  /** Fast supervisory decision; falls back to `model("decide")` when absent. */
  decide?(input: { work: CocoWork; question: unknown }, signal: AbortSignal, usage: (tokens: number, estimated: boolean, requestId: string) => void, providerId: string): Promise<unknown>;
  execute(work: CocoWork, settings: CocoSettings, signal: AbortSignal, usage: (tokens: number, estimated: boolean, requestId: string) => void, session: (id: string) => void): Promise<{ summary: string; waiting?: string; decisionPrompt?: CocoDecisionPrompt; paused?: string; interrupted?: string; deferred?: boolean; budgetHold?: boolean; evidence: unknown }>;
  followup?(work: CocoWork, mode: "steer" | "append"): Promise<void>;
  /** Preserve output before independent verification and session history retention. */
  captureResults?(workId: string): Promise<void>;
  /** Clear a budget soft-pause before re-dispatching execute (no free continuation turn). */
  resumeBudgetHold?(sessionId: string): Promise<void>;
  notice?(id: string, text: string): void;
  /** Project awareness: onboarding, newly added projects and PROJECT.md changes. */
  project?: {
    pending(now: number): boolean;
    run(signal: AbortSignal, usage: (tokens: number, estimated: boolean, requestId: string) => void, providers: { main: string; fast: string }): Promise<{ notices: string[]; changed: string[] }>;
  };
  changed?(): void;
  notify?(title: string, message: string): void;
};
export { budgetState } from "./budgetManager.js";

const NO_FIXED_WORK = "Fixed execution produced no executable work";
/** Backoff for failed rule runs (transport, structured-result or plan validation failures). */
const RULE_RETRY_DELAYS_MS = [60000, 300000, 900000];
const RECENT_RULE_RUNS = 8, KEPT_RULE_RUNS = 100;
/** Event wakes wait this long so a burst of task outcomes becomes one autonomous turn. */
const WAKE_COALESCE_MS = 3000;
const CONVERSATION_JOBS: readonly CocoJob["kind"][] = ["chat", "greet", "autonomous"];
/** Verification goal for a handed-over session (see `watchSession`); there is no planned objective to judge against. */
const HANDOVER_OBJECTIVE = [
  "The user handed this session over to CoCo. Goal: what the user asked for in the conversation below, carried through to an actual result.",
  "A last reply that stops to ask the user to review, confirm or choose a reversible next step (a plan, a proposal, a design option, \"shall I start?\") is not completion: decide it yourself and continue, e.g. \"Proceed with the plan using its recommended defaults.\"",
  "Write the continue prompt in the language of the conversation.",
].join("\n");

type ExecutionLane = { job: CocoJob; abort: AbortController; promise: Promise<void> };
/** Interactive chat, coordination and per-project task execution have independent admission. */
export class CocoEngine {
  private timer: ReturnType<typeof setInterval> | undefined;
  private leaseRetry: ReturnType<typeof setTimeout> | undefined;
  private worker: Promise<void> | undefined;
  private conversation: { job: CocoJob; abort: AbortController; promise: Promise<void> } | undefined;
  private abort: AbortController | undefined;
  /** One live task per project. Different projects run at the same time. */
  private executions = new Map<string, ExecutionLane>();
  /** Supervisory decisions block a live execution, so they never queue behind planning or verification. */
  private deciding: { job: CocoJob; abort: AbortController; promise: Promise<void> } | undefined;
  private decisions = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void }>();
  /** Live ask_user calls parked on To decide. The user's choice resumes that tool, not a new turn. */
  private workAnswers = new Map<string, (answer: string | null) => void>();
  private active: CocoJob | undefined;
  private stopped = true;
  private blocked: string | undefined;
  private owner = randomUUID();
  private lastReportCheck = 0;
  private lastLeaseRenewal = 0;
  private heartbeatAt = 0;
  /** Pending event wake (0 = none). */
  private wakeAt = 0;
  private heartbeatRunning = false;
  private releasingHolds: Promise<void> | undefined;
  readonly budget: CocoBudgetManager;
  constructor(readonly repository: CocoRepository, private ports: CocoPorts, private now: () => number = Date.now, private leaseRetryMs = 2000) {
    this.budget = new CocoBudgetManager(repository, () => this.settings(), now);
    this.budget.on("changed", () => this.emit());
    this.budget.on("reset", () => { if (!this.stopped) void this.releaseBudgetHolds().then(() => this.wake(), () => this.wake()); });
  }
  settings(): CocoSettings { return validateSettings({ ...defaultSettings(), ...this.repository.meta<Partial<CocoSettings>>("settings", {}) }); }
  setBlocked(reason?: string): void { this.blocked = reason; this.emit(); }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.acquireLeaseAndBoot();
  }
  /**
   * Lease handover. A process that vanished without releasing its lease
   * (crash, kill, the update/restart fast-exit path) leaves a row that
   * expires within 15s, so keep retrying instead of staying blocked until
   * the next app restart. A live owner renews well within its TTL, so these
   * retries can never steal a lease that is genuinely held.
   */
  private acquireLeaseAndBoot(): void {
    if (this.stopped) return;
    if (!this.repository.acquireLease(this.owner, this.now())) {
      this.blocked = "CoCo is running in another Larry Agent instance. It starts automatically once that instance stops.";
      this.emit();
      if (this.leaseRetry) clearTimeout(this.leaseRetry);
      this.leaseRetry = setTimeout(() => { this.leaseRetry = undefined; this.acquireLeaseAndBoot(); }, this.leaseRetryMs);
      this.leaseRetry.unref?.();
      return;
    }
    this.blocked = undefined;
    this.lastLeaseRenewal = this.now();
    this.lastReportCheck = this.now();
    this.heartbeatAt = this.now() + this.settings().heartbeatMinutes * 60000;
    this.wakeAt = 0;
    const enabled = this.settings().enabled;
    this.repository.transaction(() => {
      // A visit greeting belongs to that visit, not to crash recovery.
      for (const job of this.jobs()) if (job.kind === "greet") this.repository.put("job", { ...job, status: "done" });
      for (const job of this.jobs()) if (job.status === "running" || job.kind === "decision") {
        this.repository.put("job", { ...job, status: job.workId || job.kind === "chat" ? "done" : "queued" });
      }
      for (const work of this.works()) if (work.status === "to_decide" && /^(?:CoCo|Coco) context is too large; narrow the project scope[.]?$/.test(work.summary.trim())) {
        const last=this.repository.list<CocoJob>("job").filter(j=>j.workId===work.id).at(-1);
        if(last?.kind==="verify")this.update(work,"verifying","Resuming acceptance with automatic session context management.");
        else if(work.sessionId)this.queueRecovery(work,"Recovering a context-capacity interruption automatically.",true);
        else this.update(work,"queued","Resuming work with automatic session context management.");
      }
      for (const work of this.works()) if (work.status === "executing") {
        this.queueRecovery(work,"The application stopped during this task; inspect the saved session and recover it.",true);
        if (enabled) this.ledgerWork(work, "interrupted", "app_restart");
      }
      for (const message of this.repository.list<CocoMessage>("message")) if (message.status === "streaming") this.repository.put("message", { ...message, status: "stopped" });
      for (const attempt of this.repository.list<CocoAttempt>("attempt")) if (attempt.status === "running") this.repository.put("attempt", { ...attempt, status: "interrupted", endedAt: this.now() });
      // Offline occurrences are never enqueued; interval rules keep their phase across restarts.
      for (const rule of this.rules()) this.repository.put("rule", { ...this.migrateRule(rule), nextRunAt: this.bootRuleTime(rule) });
    });
    // Restart interruptions (written here or by the closing process) wake CoCo right after boot.
    if (enabled && undeliveredWakeEntries(this.repository).some(e => e.reason === "app_restart")) this.wakeAt = this.now() + WAKE_COALESCE_MS;
    this.timer = setInterval(() => { this.wake(); }, 1000);
    this.timer.unref();
    this.budget.start();
    // Holds left by a previous process whose window already rolled over never see a `reset` edge.
    if (!this.budget.cooling()) void this.releaseBudgetHolds().then(() => this.wake(), () => this.wake());
    this.wake();
  }
  stop(): void {
    this.stopped = true;
    this.budget.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.leaseRetry) clearTimeout(this.leaseRetry);
    this.leaseRetry = undefined;
    const runningJobs = this.executionLanes().map(lane => lane.job);
    this.abort?.abort(); this.abortExecutions(); this.conversation?.abort.abort(); this.deciding?.abort.abort();
    for (const pending of this.decisions.values()) pending.reject(new Error("CoCo stopped"));
    this.decisions.clear();
    for (const deliver of [...this.workAnswers.values()]) deliver(null);
    this.workAnswers.clear();
    const interrupted = runningJobs.length ? runningJobs : this.active ? [this.active] : [];
    if (this.repository.ownsLease(this.owner, this.now())) {
      for (const job of interrupted) {
        if (!job.workId) continue;
        const work = this.repository.get<CocoWork>("work", job.workId);
        if (work?.status !== "executing") continue;
        this.queueRecovery(work,"The application closed. Recover this task after Larry Agent is reopened.",true);
        if (this.settings().enabled) this.ledgerWork(work, "interrupted", "app_restart");
      }
    }
    // Stopping ends this runtime's ownership in every case: a process on its
    // way out (update/restart fast-exit) must not leave the lease to expire
    // on TTL. Lanes aborted above settle later, but every write they could
    // still attempt is guarded by ownsLease, and releaseLease is idempotent
    // for their finally blocks.
    this.repository.releaseLease(this.owner);
    this.emit();
  }
  async settled(): Promise<void> { await Promise.all([this.worker, ...this.executionLanes().map(lane => lane.promise), this.conversation?.promise, this.deciding?.promise]); }
  /**
   * Park the running execution on To decide. Resolves with the user's choice
   * so the waiting ask_user tool can continue the same turn.
   */
  awaitWorkAnswer(workId: string, text: string, prompt: CocoDecisionPrompt, signal: AbortSignal): Promise<string | null> {
    const work = this.repository.get<CocoWork>("work", workId);
    if (!work || signal.aborted) return Promise.resolve(null);
    this.update(work, "to_decide", text, prompt, true);
    this.ports.notify?.("CoCo · To decide", prompt.question);
    this.emit();
    return new Promise(resolve => {
      let settled = false;
      const finish = (answer: string | null): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        this.workAnswers.delete(workId);
        if (answer !== null) {
          const current = this.repository.get<CocoWork>("work", workId);
          if (current?.status === "to_decide") this.update(current, "executing", "Continuing with your decision");
        }
        resolve(answer);
      };
      const onAbort = (): void => finish(null);
      signal.addEventListener("abort", onAbort, { once: true });
      this.workAnswers.set(workId, finish);
    });
  }
  async ask(workId: string, question: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const abort = (): void => { this.decisions.delete(id); reject(new Error("Decision interrupted")); };
      signal.addEventListener("abort", abort, { once: true });
      this.decisions.set(id, { resolve: value => { signal.removeEventListener("abort", abort); resolve(value); }, reject: error => { signal.removeEventListener("abort", abort); reject(error); } });
      this.repository.put<CocoJob>("job", { id, kind: "decision", status: "queued", at: this.now(), priority: 20000, workId, input: JSON.stringify(question) });
      this.wake();
    });
  }
  private emit(): void { this.ports.changed?.(); }
  ownsExecution(): boolean { return !this.stopped && this.repository.ownsLease(this.owner, this.now()); }
  private executionLanes(): ExecutionLane[] { return [...this.executions.values()]; }
  private executionJob(): CocoJob | undefined { return this.executionLanes()[0]?.job; }
  private executionForWork(workId: string | undefined): ExecutionLane | undefined {
    if (!workId) return undefined;
    for (const lane of this.executions.values()) if (lane.job.workId === workId) return lane;
    return undefined;
  }
  private abortExecutions(): void { for (const lane of this.executions.values()) lane.abort.abort(); }
  private clearExecution(jobId: string): void {
    for (const [workspaceId, lane] of this.executions) if (lane.job.id === jobId) this.executions.delete(workspaceId);
  }
  /**
   * A project is busy while one of its tasks may still read or write files.
   * Watching a user turn does not hold the project. `sessions` adds live-turn
   * occupancy: an automated rule deployment waits for a running session in the
   * same project (an empty list checks CoCo-internal occupancy only).
   */
  private workspaceOccupied(workspaceId: string, sessions: readonly { workspaceId: string; status: string }[] = []): boolean {
    if (this.executions.has(workspaceId)) return true;
    if (this.works().some(work => work.workspaceId === workspaceId && !work.waitingForSession && occupiesWorkspace(work.status))) return true;
    return sessions.some(session => session.workspaceId === workspaceId && session.status === "running");
  }
  private wake(): void { void this.tick().catch(error => { this.blocked = String(error); this.abort?.abort(); this.abortExecutions(); this.conversation?.abort.abort(); this.deciding?.abort.abort(); this.emit(); }); }
  private works(): CocoWork[] { return this.repository.list<CocoWork>("work"); }
  private lastInteractionAt(): number {
    return this.repository.list<CocoMessage>("message").reduce((at, m) => m.text.trim() && m.status !== "error" ? Math.max(at, m.at) : at, 0);
  }
  /**
   * Nothing is running: one light small-talk remark instead of a model review
   * of finished work. Waits out the small-talk interval, and an unanswered
   * remark is not followed by another one.
   */
  private queueIdleSmallTalk(): void {
    if (this.conversation || this.jobs().some(j => CONVERSATION_JOBS.includes(j.kind))) return;
    const lastRemark = this.repository.meta<number>("idleSmallTalkAt", 0);
    const lastUser = this.repository.list<CocoMessage>("message").reduce((at, m) => m.role === "user" ? Math.max(at, m.at) : at, 0);
    if (lastRemark && lastUser <= lastRemark) return;
    const spokenAt = this.repository.meta<VisitState | undefined>("visitState", undefined)?.spokenAt ?? 0;
    if (this.now() - Math.max(this.lastInteractionAt(), spokenAt) < SMALL_TALK_INTERVAL) return;
    this.repository.setMeta("idleSmallTalkAt", this.now());
    this.enqueue({ kind: "greet", priority: 0, input: "smalltalk" });
  }
  /** Check-in rules and rule event triggers are retired: check-ins become paused inspections. */
  private migrateRule(rule: CocoRule): CocoRule {
    const legacy = rule as CocoRule & { events?: unknown };
    const { events: _events, ...rest } = legacy;
    return (rule.mode as string) === "checkin" ? { ...rest, mode: "inspection", enabled: false } : rest;
  }
  /**
   * Record a fact for the next autonomous wake. Only while CoCo is enabled;
   * `wake` schedules a coalesced event wake (task outcomes, workspace changes).
   */
  recordWake(entry: Omit<CocoWakeEntry, "id" | "deliveredAt" | "at">, wake: boolean): void {
    if (!this.ownsExecution() || !this.settings().enabled) return;
    appendWakeEntry(this.repository, { ...entry, at: this.now() });
    if (wake) this.scheduleWake();
  }
  private scheduleWake(): void { if (!this.wakeAt) this.wakeAt = this.now() + WAKE_COALESCE_MS; }
  private ledgerWork(work: CocoWork, outcome: NonNullable<CocoWakeEntry["outcome"]>, reason?: CocoWakeEntry["reason"]): void {
    const workspace = this.ports.context(this.settings()).workspaces.find(w => w.id === work.workspaceId);
    appendWakeEntry(this.repository, {
      at: this.now(), kind: "work_status", workspaceId: work.workspaceId, workspaceName: workspace?.name ?? work.workspaceId,
      workspacePath: workspace?.path ?? "", workId: work.id, workTitle: work.title, outcome, ...(reason ? { reason } : {}),
    });
  }
  private wakeProjects(context = this.ports.context(this.settings())): CocoWakeProject[] {
    return context.workspaces.flatMap(w => w.path ? [{ id: w.id, name: w.name, path: w.path }] : []);
  }
  private async readVcs(projects: CocoWakeProject[]): Promise<Record<string, CocoVcsFact | null>> {
    if (!this.ports.vcs || !projects.length) return {};
    try { return await this.ports.vcs(projects); } catch (error) { console.warn("[coco] version read failed:", error); return {}; }
  }
  /** Heartbeat: wake when the ledger has entries or a project version moved; otherwise maybe one small-talk remark. */
  private async heartbeat(): Promise<void> {
    if (this.heartbeatRunning) return;
    this.heartbeatRunning = true;
    try {
      const projects = this.wakeProjects(), current = await this.readVcs(projects);
      if (!this.ownsExecution() || !this.settings().enabled) return;
      let baseline = this.repository.meta<Record<string, CocoVcsFact>>("vcsBaseline", {});
      const seeded = seedVcsBaseline(baseline, current);
      if (seeded) { this.repository.setMeta("vcsBaseline", seeded); baseline = seeded; }
      const changed = undeliveredWakeEntries(this.repository).length > 0 || vcsChanges(projects, baseline, current).length > 0;
      this.repository.transaction(() => {
        if (changed) this.enqueue({ kind: "autonomous", priority: 0, input: "heartbeat" });
        else if (!this.works().some(w => isActiveWork(w.status))) this.queueIdleSmallTalk();
      });
      this.emit(); this.wake();
    } catch (error) { console.warn("[coco] heartbeat failed:", error); }
    finally { this.heartbeatRunning = false; }
  }
  /** Validate a model-submitted plan against live state (not context captured before a tool round) and accept it. */
  private commitPlan(job: CocoJob, raw: unknown): { drafted: number } {
    const live = this.ports.context(this.settings());
    const plan = validatePlan(raw, new Set(live.workspaces.map(w => w.id)), new Set(live.sessions.map(s => s.id)), new Set(this.works().filter(w => live.workspaces.some(p => p.id === w.workspaceId)).map(w => w.id)), new Map(live.sessions.map(s => [s.id, s.workspaceId])));
    const before = new Set(this.works().map(w => w.id));
    const ids = this.repository.transaction(() => this.acceptPlan(plan, job, undefined, false));
    this.emit(); this.wake();
    return { drafted: ids.filter(id => !before.has(id) && this.repository.get<CocoWork>("work", id)?.status === "draft").length };
  }
  /**
   * Commander rule changes go through the same `rule` command as the panel, so
   * validation, scope checks and aborting affected work stay identical.
   */
  private changeRule(raw: unknown): { id: string; name: string; enabled?: boolean; nextRunAt?: number; deleted?: true } {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A rule change must be an object");
    const change = raw as { action?: unknown; ruleId?: unknown; rule?: unknown };
    // Models often nest the id inside the patch; accept it there as a fallback.
    const nested = change.rule && typeof change.rule === "object" && !Array.isArray(change.rule) ? change.rule as { ruleId?: unknown; id?: unknown } : {};
    const ruleId = [change.ruleId, nested.ruleId, nested.id].find((v): v is string => typeof v === "string" && v.trim() !== "")?.trim();
    if (!ruleId) throw new Error("Missing ruleId: pass the rule's `id` (from the rules in coco_context) as the top-level `ruleId` argument, next to `rule`.");
    const rule = this.repository.get<CocoRule>("rule", ruleId);
    if (!rule) {
      const byName = this.rules().find(r => r.name.trim().toLowerCase() === ruleId.toLowerCase());
      throw new Error(byName
        ? `ruleId must be the rule's id, not its name: use ruleId "${byName.id}" for "${byName.name}".`
        : `Unknown ruleId "${ruleId.slice(0, 120)}". Existing rule ids are listed in the coordination context and coco_context.`);
    }
    if (change.action === "delete") { this.command({ type: "rule", action: "delete", id: rule.id }); return { id: rule.id, name: rule.name, deleted: true }; }
    if (change.action === "pause") { if (rule.enabled) this.command({ type: "rule", action: "toggle", id: rule.id }); }
    else if (change.action === "resume") this.command({ type: "rule", action: "confirm", id: rule.id });
    else if (change.action === "update") {
      if (!change.rule || typeof change.rule !== "object" || Array.isArray(change.rule)) throw new Error("update needs a `rule` object with the fields to change");
      const patch = change.rule as Partial<CocoRule>;
      const editable = ["name", "objective", "mode", "enabled", "providerId", "cadence", "acceptance", "runMode", "reasoningEffort"] as const;
      const next: CocoRule = { ...rule, ...Object.fromEntries(editable.filter(key => patch[key] !== undefined).map(key => [key, patch[key]])), ...(patch.scope ? { scope: { ...rule.scope, ...patch.scope } } : {}) };
      this.command({ type: "rule", action: "save", rule: next });
    } else throw new Error("Unknown rule action");
    const saved = this.repository.get<CocoRule>("rule", rule.id)!;
    return { id: saved.id, name: saved.name, enabled: saved.enabled, nextRunAt: saved.nextRunAt };
  }
  /** In-scope work for model input; links to deleted sessions are dropped so plans do not reuse them. */
  private modelWork(context: CocoContext): CocoWork[] {
    const live = new Set(context.sessions.map(s => s.id));
    return this.works().filter(w => context.workspaces.some(p => p.id === w.workspaceId)).map(w => w.sessionId && !live.has(w.sessionId) ? { ...w, sessionId: undefined } : w);
  }
  /** Rule-triggered inspections only; retries keep the same job id and therefore the same run. */
  private recordRuleRun(job: CocoJob, patch: Partial<Omit<CocoRuleRun, "id" | "ruleId">>): void {
    if (job.kind !== "inspect" || !job.ruleId) return;
    const previous = this.repository.get<CocoRuleRun>("ruleRun", job.id);
    const ruleName = this.repository.get<CocoRule>("rule", job.ruleId)?.name ?? previous?.ruleName ?? "Removed rule";
    this.repository.put<CocoRuleRun>("ruleRun", { startedAt: this.now(), status: "running", workIds: [], ...previous, ...patch, id: job.id, ruleId: job.ruleId, ruleName, attempts: (job.retries ?? 0) + 1 });
    if (previous) return;
    const runs = this.repository.list<CocoRuleRun>("ruleRun");
    for (const old of runs.slice(0, Math.max(0, runs.length - KEPT_RULE_RUNS))) this.repository.remove("ruleRun", old.id);
  }
  private jobs(): CocoJob[] { return this.repository.pending<CocoJob>("job"); }
  private rules(): CocoRule[] { return this.repository.list<CocoRule>("rule"); }
  private nextRuleTime(rule: Pick<CocoRule, "cadence">): number {
    const next = nextRunAt(rule.cadence, new Date(this.now())).getTime();
    if (!Number.isSafeInteger(next) || next <= this.now()) throw new Error("Schedule exceeds the supported time range");
    return next;
  }
  private bootRuleTime(rule: Pick<CocoRule, "cadence" | "nextRunAt">): number {
    if (rule.cadence.kind !== "minute" || !Number.isSafeInteger(rule.nextRunAt) || rule.nextRunAt <= 0) return this.nextRuleTime(rule);
    const period = rule.cadence.n * 60000, now = this.now();
    // A schedule further out than one period predates a clock change; rebase it.
    if (rule.nextRunAt > now) return rule.nextRunAt - now <= period ? rule.nextRunAt : this.nextRuleTime(rule);
    return rule.nextRunAt + (Math.floor((now - rule.nextRunAt) / period) + 1) * period;
  }
  private enqueue(input: Omit<CocoJob, "id" | "status" | "at">): void {
    if (this.jobs().some(j => j.status !== "done" && j.kind === input.kind && (input.workId ? j.workId === input.workId : input.ruleId ? j.ruleId === input.ruleId : input.messageId ? j.messageId === input.messageId : input.kind === "inspect" ? !j.ruleId : true))) return;
    this.repository.put("job", { ...input, id: randomUUID(), status: "queued", at: this.now() });
  }
  /**
   * `liveQuestion`: an ask_user parked on To decide while the turn waits. That
   * is the unchanged auto-answer path, not a failed task, so it is not ledgered.
   */
  private update(work: CocoWork, status: CocoWork["status"], text: string, prompt?: CocoDecisionPrompt | null, liveQuestion = false): CocoWork {
    if (status !== work.status && (status === "completed" || (status === "to_decide" && !liveQuestion)) && this.settings().enabled) {
      const exhausted = /^Automatic (?:recovery|continuation) limit reached/.test(text.trim());
      this.ledgerWork({ ...work, status }, status === "completed" ? "completed" : "failed", status === "to_decide" && exhausted ? "retries_exhausted" : undefined);
      this.scheduleWake();
    }
    return this.repository.put("work", {
      ...work,
      status,
      summary: text,
      updatedAt: this.now(),
      ...(status === "to_decide"
        ? { decision: text, decisionPrompt: decisionPromptFor(text, prompt) }
        : { decision: undefined, decisionPrompt: undefined }),
      timeline: [...work.timeline, { at: this.now(), text, status, revision: work.revision }],
    });
  }
  private runState(settings: CocoSettings, resumeAt: () => number | undefined): CocoSnapshot["state"] {
    return this.blocked ? "blocked" : this.stopped ? "stopping" : !settings.enabled ? "paused" : (this.active || this.executions.size) ? "working" : resumeAt() ? "cooldown" : "idle";
  }
  /** Shell icon state without assembling the full snapshot. */
  activity(): CocoActivity {
    const state = this.runState(this.settings(), () => this.budget.state().resumeAt);
    return cocoActivity({ state, chat: this.ports.chatStatus?.() ?? this.ports.chatState?.(), chatJob: this.conversation?.job, planningJob: this.active, executionJob: this.executionJob(), activeJob: this.active ?? this.executionJob(), work: state === "working" ? this.works() : [] });
  }
  snapshot(): CocoSnapshot {
    const settings = this.settings(), { hourly, daily, estimated, resumeAt } = this.budget.state(), budget = { hourly, daily, estimated, ...(resumeAt ? { resumeAt } : {}) };
    const rules = this.rules(), history = rules.map(rule => ({ id:rule.id, page:this.repository.history(rule.id) }));
    const state = this.runState(settings, () => budget.resumeAt);
    return { activationSeen: this.repository.meta("activationSeen", false), pendingPlans:this.jobs().filter(j=>j.kind==="plan"&&j.messageId).map(j=>({requestId:j.messageId!,title:(j.planPrompt??"").slice(0,180),status:j.status as "queued"|"running"})), backgroundTasks: this.ports.backgroundTasks?.() ?? [], chat: this.ports.chatState?.(), chatJob:this.conversation?.job, planningJob:this.active, executionJob:this.executionJob(), reportJob:this.jobs().find(j=>j.kind==="report"), runningRuleIds:[...new Set(this.jobs().filter(j=>j.kind==="inspect"&&j.ruleId).map(j=>j.ruleId!))], toolApprovals: this.repository.list<CocoToolApproval>("toolApproval").filter(a => ["pending", "approved"].includes(a.status)), settings, state, activeJob: this.active ?? this.executionJob(), error: this.blocked, resumeAt: budget.resumeAt, budget, work: this.works(), rules, messages: this.repository.list<CocoMessage>("message").slice(-200), reports: this.repository.list<CocoReport>("report").reverse(), verifications: this.repository.list("verification"), attempts: this.repository.list("attempt"), ruleRuns: recentRuns([...this.repository.list<CocoRuleRun>("ruleRun"), ...chatRuns(this.works(), this.repository.list<CocoMessage>("message"))], RECENT_RULE_RUNS), legacyRuns: history.flatMap(h=>h.page.runs), legacyCursors: Object.fromEntries(history.map(h=>[h.id,h.page.nextCursor])), workspaces: this.ports.context(settings).workspaces, ...this.ports.settingsOptions?.() };
  }
  command(command: CocoCommand): CocoSnapshot {
    if (!this.ownsExecution() || this.blocked) throw new Error(this.blocked ?? "CoCo is initializing or stopping; retry when it is ready");
    if (!command || typeof command !== "object") throw new Error("Invalid CoCo command");
    this.repository.transaction(() => {
      switch (command.type) {
        case "wake": {
          if (!this.settings().enabled) break;
          if (this.conversation || this.jobs().some(j => CONVERSATION_JOBS.includes(j.kind))) break;
          const snapshot = this.snapshot();
          const previous = this.repository.meta<VisitState | undefined>("visitState", undefined);
          const lastInteraction = this.lastInteractionAt();
          const visit = visitWake(snapshot, previous, lastInteraction, this.now());
          if (!visit.mode) {
            this.repository.setMeta("visitState", { fingerprint: visit.fingerprint, spokenAt: previous?.spokenAt ?? 0 });
            break;
          }
          if (visit.mode === "smalltalk" && this.now() - this.repository.meta<number>("lastVisitWake", 0) < 60000) break;
          this.repository.setMeta("lastVisitWake", this.now());
          if (snapshot.resumeAt || !snapshot.workspaces.length) {
            const active = snapshot.work.find(w => snapshot.workspaces.some(p => p.id === w.workspaceId) && isActiveWork(w.status));
            const stage = active ? `“${active.title}” is ${active.status === "verifying" ? "being verified" : active.status === "recovering" ? "recovering" : "in progress"}. ` : "";
            const fallback = snapshot.resumeAt ? `${stage}Automatic work is waiting for its budget to reset; we can still chat.` : "I'm here. Add a project when you're ready, or we can talk first.";
            this.publishNotice(`visit-${this.now()}`, fallback);
            this.repository.setMeta("visitState", { fingerprint: visit.fingerprint, spokenAt: this.now() });
          } else this.enqueue({ kind: "greet", priority: 0, input: visit.mode, wakeFingerprint: visit.fingerprint });
          break;
        }
        case "activation": {
          if (!["visit", "enable"].includes(command.action)) throw new Error("Unknown activation action");
          this.repository.setMeta("activationSeen", true);
          if (command.action === "enable") {
            this.repository.setMeta("settings", { ...this.settings(), enabled: true });
            this.heartbeatAt = this.now() + this.settings().heartbeatMinutes * 60000;
            this.ports.scopeChanged?.();
          }
          break;
        }
        case "chatControl": {
          if (command.action === "stop") { if (!this.conversation) throw new Error("CoCo is not replying"); this.conversation.abort.abort(); }
          else if (!this.ports.chatControl) throw new Error("CoCo Chat is unavailable");
          else {
            this.ports.chatControl(command);
            if (command.action === "answer") this.repository.put<CocoMessage>("message", { id: randomUUID(), role: "user", text: command.selections?.join(", ") ?? command.selected, at: this.now() });
          }
          break;
        }
        case "toolApproval": {
          const approval = this.repository.get<CocoToolApproval>("toolApproval", command.id);
          const work = approval && this.repository.get<CocoWork>("work", approval.workId);
          if (!approval || approval.status !== "pending" || !work || work.status !== "to_decide" || work.revision !== approval.revision || (this.active?.workId === work.id || this.executionForWork(work.id))) throw new Error("This tool decision is no longer current");
          if (!["approve", "deny"].includes(command.action)) throw new Error("Unknown tool decision");
          this.repository.put("toolApproval", { ...approval, status: command.action === "approve" ? "approved" : "denied" });
          if (command.action === "approve") this.applyWorkCommand({ type: "work", id: work.id, action: "resume" });
          else this.update(work, "waiting", "Tool invocation declined by you. Revise the goal before continuing.");
          break;
        }
        case "goal": {
          if (!["start", "cancel"].includes(command.action)) throw new Error("Unknown goal action");
          const work = this.works().filter(w => (w.goalId === command.id || w.goalIds?.includes(command.id)) && !isTerminalWork(w.status));
          const plans=this.jobs().filter(j=>j.kind==="plan"&&j.messageId===command.id);
          if(command.action==="cancel"&&plans.length){for(const plan of plans)this.repository.put("job",{...plan,status:"done"});if(this.active?.kind==="plan"&&this.active.messageId===command.id)this.abort?.abort();}
          if (!work.length && !plans.length) throw new Error("Unknown or finished goal");
          for (const item of work) if (command.action === "cancel" || item.status === "draft") this.applyWorkCommand({ type: "work", id: item.id, action: command.action });
          break;
        }
        case "settings": {
          const settings = validateSettings(command.settings);
          const previous = this.settings();
          this.repository.setMeta("settings", settings);
          if (settings.enabled && (!previous.enabled || settings.heartbeatMinutes !== previous.heartbeatMinutes)) this.heartbeatAt = this.now() + settings.heartbeatMinutes * 60000;
          if (settings.enabled) this.repository.setMeta("activationSeen", true);
          const scopeChanged = JSON.stringify([...previous.excludedWorkspaceIds].sort()) !== JSON.stringify([...settings.excludedWorkspaceIds].sort());
          if (settings.enabled && (scopeChanged || !previous.enabled)) this.ports.scopeChanged?.();
          if (scopeChanged) { this.repository.setMeta("contextSince", this.now()); this.conversation?.abort.abort(); }
          // Turning CoCo off stops both conversation and automatic work.
          if (!settings.enabled) this.conversation?.abort.abort();
          if (scopeChanged || !settings.enabled) {
            for (const lane of this.executionLanes()) {
              const activeWork = lane.job.workId ? this.repository.get<CocoWork>("work", lane.job.workId) : undefined;
              if (activeWork?.status === "executing") this.update(activeWork,"waiting",scopeChanged?"Project access changed; review this task before continuing.":"CoCo automation was paused by you.");
              lane.abort.abort();
            }
            this.abort?.abort();
          }
          break;
        }
        case "chat": {
          if (!this.settings().enabled) throw new Error("Enable CoCo before sending a message.");
          if (typeof command.text !== "string" || !command.text.trim() || command.text.length > 20000) throw new Error("Enter a goal of at most 20,000 characters");
          if (command.handoverInstruction !== undefined && (typeof command.handoverInstruction !== "string" || command.handoverInstruction.trim().length === 0 || command.handoverInstruction.length > 4000)) throw new Error("Invalid hand-over instruction");
          if (command.workId && !this.repository.get("work", command.workId)) throw new Error("Unknown work reference");
          // The user speaking supersedes an automatic remark. A running autonomous turn finishes first; the message queues behind it.
          if (this.conversation?.job.kind === "greet") this.conversation.abort.abort();
          for (const job of this.jobs()) if (job.kind === "greet" && job.status === "queued") this.repository.put("job", { ...job, status: "done" });
          const message: CocoMessage = { id: randomUUID(), role: "user", text: command.text.trim(), at: this.now(), ...(command.workId ? { workId: command.workId } : {}) };
          this.repository.put("message", message);
          const question = this.ports.chatState?.()?.question;
          if (question && this.ports.chatControl && (question.allowCustom || !question.options.length || question.options.includes(message.text))) {
            this.ports.chatControl({ type: "chatControl", action: "answer", requestId: question.requestId, selected: message.text, custom: !question.options.includes(message.text) });
            break;
          }
          this.enqueue({ kind: "chat", priority: 10000, messageId: message.id, input: command.workspaceId, planOnly: command.planOnly === true, ...(command.continuation ? { continuation: command.continuation } : {}), ...(command.handoverInstruction ? { handoverInstruction: command.handoverInstruction } : {}) });
          break;
        }
        case "work": {
          this.applyWorkCommand(command);
          break;
        }
        case "rule": {
          const changedRuleId = command.action === "save" ? command.rule?.id : command.id;
          for (const lane of this.executionLanes()) {
            const activeWork = lane.job.workId ? this.repository.get<CocoWork>("work", lane.job.workId) : undefined;
            if (activeWork?.ruleIds.includes(changedRuleId)) lane.abort.abort();
          }
          if (command.action === "save") {
            const rule = validateRule(command.rule);
            const previous = this.repository.get<CocoRule>("rule", rule.id);
            if (previous?.legacyId) { rule.legacyId = previous.legacyId; rule.legacyConfig = previous.legacyConfig; }
            rule.origin = previous?.origin ?? "user";
            if (previous?.goalId) rule.goalId = previous.goalId;
            const context = this.ports.context(this.settings());
            if (rule.scope.workspaceIds.some(id => !context.workspaces.some(w => w.id === id))) throw new Error("Rule includes an excluded or missing project");
            rule.confirmed = true;
            rule.nextRunAt = this.nextRuleTime(rule);
            this.repository.put("rule", rule);
          } else {
            const rule = this.repository.get<CocoRule>("rule", command.id);
            if (!rule) throw new Error("Unknown rule");
            if (command.action === "delete") this.repository.remove("rule", rule.id);
            else if (command.action === "run") {
              if (!rule.confirmed || !rule.enabled) throw new Error("Enable this rule first");
              this.enqueue({ kind: "inspect", priority: 40, ruleId: rule.id });
            } else if (command.action === "confirm" || command.action === "toggle") this.repository.put("rule", { ...rule, confirmed: true, enabled: command.action === "confirm" || !rule.enabled, nextRunAt: this.nextRuleTime(rule) });
            else throw new Error("Unknown rule action");
          }
          break;
        }
        case "budget": {
          if (command.action !== "reset") throw new Error("Unknown budget action");
          this.budget.clearCurrentWindow();
          break;
        }
        case "autonomousPrompt": {
          if (command.action !== "reset" || !this.ports.resetAutonomousPrompt) throw new Error("Unknown autonomous instructions action");
          this.ports.resetAutonomousPrompt();
          break;
        }
        case "report": this.enqueue({ kind: "report", priority: 30 }); break;
        default: throw new Error("Unknown CoCo command");
      }
    });
    this.emit(); this.wake(); return this.snapshot();
  }
  /**
   * Hand-over supervision: track a CoCo-managed session as observed work. Once
   * its turn ends, verification decides complete / continue / needs_user and a
   * continue prompt is sent into the same session. No-op while open work
   * already covers the session.
   */
  watchSession(input: { sessionId: string; workspaceId: string; title: string; providerId?: string | undefined; runMode?: CocoWork["runMode"]; reasoningEffort?: CocoWork["reasoningEffort"] }): boolean {
    if (!this.ownsExecution() || this.blocked || !this.settings().enabled) return false;
    if (!this.ports.context(this.settings()).workspaces.some(w => w.id === input.workspaceId)) return false;
    if (this.works().some(w => !isTerminalWork(w.status) && (w.sessionId === input.sessionId || w.observeSessionId === input.sessionId))) return false;
    const id = randomUUID(), now = this.now();
    this.repository.put<CocoWork>("work", {
      id, goalId: id, goalIds: [id], handover: true, observeSessionId: input.sessionId, title: input.title, objective: HANDOVER_OBJECTIVE, workspaceId: input.workspaceId,
      status: "queued", priority: 60, prioritySource: "coco", dependsOn: [], steps: [], acceptance: [], deliverables: [], ruleIds: [], revision: 1, repairs: 0,
      fullPermissions: true, providerId: input.providerId ?? "", runMode: input.runMode ?? "agent", reasoningEffort: input.reasoningEffort,
      createdAt: now, updatedAt: now, summary: "Watching the handed-over session", timeline: [{ at: now, text: "Handed over; the next finished turn is reviewed and continued" }],
    });
    this.enqueue({ kind: "execute", workId: id, priority: 60 });
    this.emit(); this.wake();
    return true;
  }
  /** Take-back: stop hand-over supervision of this session (in-flight CoCo continuation turns are cancelled). */
  releaseSession(sessionId: string): void {
    if (!this.ownsExecution()) return;
    const watched = this.works().filter(w => w.handover && w.observeSessionId === sessionId && !isTerminalWork(w.status));
    if (!watched.length) return;
    this.repository.transaction(() => { for (const work of watched) this.applyWorkCommand({ type: "work", id: work.id, action: "cancel" }); });
    this.emit(); this.wake();
  }
  private applyWorkCommand(command: Extract<CocoCommand, { type: "work" }>): void {
    const work = this.repository.get<CocoWork>("work", command.id);
    if (!work) throw new Error("Unknown work item");
    if (!["start", "pause", "resume", "cancel", "priority"].includes(command.action)) throw new Error("Unknown work action");
    if (command.action === "priority") {
      if (!Number.isInteger(command.priority) || command.priority! < 0 || command.priority! > 100) throw new Error("Invalid priority");
      work.priority = command.priority!;
      work.prioritySource = "user";
      this.repository.put("work", work);
      for (const job of this.jobs()) if (job.workId === work.id && job.status === "queued") this.repository.put("job", { ...job, priority: work.priority });
      return;
    }
    let answerAdvances = false;
    if (["start", "resume"].includes(command.action)) {
      const deliver = this.workAnswers.get(work.id);
      if (deliver) {
        const answer = typeof command.answer === "string" ? command.answer.trim() : "";
        if (!answer) throw new Error("Choose a decision before continuing");
        deliver(answer);
        return;
      }
      if (work.advanceOnAnswer) {
        const answer = typeof command.answer === "string" ? command.answer.trim() : "";
        if (!answer) throw new Error("Choose a decision before continuing");
        work.advancePrompt = answer.slice(0, 2000);
        work.advanceOnAnswer = false;
        answerAdvances = true;
      }
    }
    if ((this.active?.workId === work.id || this.executionForWork(work.id)) && ["start", "resume"].includes(command.action)) throw new Error("Wait for the current turn to stop before resuming");
    if (isTerminalWork(work.status)) throw new Error("Finished work cannot be restarted");
    if (["start", "resume"].includes(command.action) && this.repository.list<CocoToolApproval>("toolApproval").some(a => a.workId === work.id && a.revision === work.revision && a.status === "pending")) throw new Error("Approve or decline the exact tool invocation before resuming");
    if (command.action === "pause" || command.action === "cancel") {
      this.clearQueuedWorkJobs(work.id);
      this.update(work, command.action === "cancel" ? "cancelled" : "waiting", command.action === "cancel" ? "Cancelled by you" : "Paused by you");
      if (this.active?.workId === work.id) this.abort?.abort();
      const lane = this.executionForWork(work.id);
      if (lane) lane.abort.abort();
      if (this.deciding?.job.workId === work.id) this.deciding.abort.abort();
    } else {
      for (const job of this.jobs()) if (job.workId === work.id && job.status === "queued") this.repository.put("job", { ...job, status: "done" });
      if (!answerAdvances && typeof command.answer === "string" && command.answer.trim()) {
        work.objective += `\nUser decision: ${command.answer.slice(0, 12000)}`;
        work.revision += 1;
      }
      work.resumeSession = true;
      work.recovery = undefined; work.recoverAt = undefined; work.recoveryAttempts = 0;
      work.waitingForSession = false;
      this.update(work, "queued", "Ready to continue");
      this.enqueue({ kind: "execute", priority: work.priority, workId: work.id });
    }
  }
  async tick(): Promise<void> {
    if (this.stopped || this.blocked) return;
    const renewed = this.now() - this.lastLeaseRenewal >= 5000
      ? this.repository.renewLease(this.owner, this.now())
      : this.repository.ownsLease(this.owner, this.now());
    if (!renewed) {
      // A suspended process must not renew a lease already taken by another runtime.
      this.abort?.abort(); this.abortExecutions(); this.conversation?.abort.abort(); this.blocked = "CoCo execution ownership expired. Restart to recover safely."; this.emit(); return;
    }
    if (this.now() - this.lastLeaseRenewal >= 5000) this.lastLeaseRenewal = this.now();
    const enabled = this.settings().enabled;
    const now = this.now();
    if (enabled) this.repository.transaction(() => {
      if(this.ports.cleanup && this.settings().historyRetentionDays && now-this.repository.meta("lastHistoryCleanup",0)>=86400000){this.enqueue({kind:"cleanup",priority:1});this.repository.setMeta("lastHistoryCleanup",now);}
      if (now - this.repository.meta("lastWakePrune", 0) >= 86400000) { pruneWakeEntries(this.repository, now); this.repository.setMeta("lastWakePrune", now); }
      if (this.wakeAt && now >= this.wakeAt) {
        this.wakeAt = 0;
        if (undeliveredWakeEntries(this.repository).length) this.enqueue({ kind: "autonomous", priority: 0, input: "event" });
      }
      for (const rule of this.rules()) {
        if (!rule.enabled || !rule.confirmed || rule.nextRunAt > now) continue;
        // Deployment preflight: a scheduled run stays due (rechecked every tick)
        // while every project in its scope is busy, then runs once one is idle.
        const scope = this.ports.context(this.settings(), rule);
        if (scope.workspaces.length && scope.workspaces.every(workspace => this.workspaceOccupied(workspace.id, scope.sessions))) continue;
        this.enqueue({ kind: "inspect", priority: 20, ruleId: rule.id });
        this.repository.put("rule", { ...rule, nextRunAt: this.nextRuleTime(rule) });
      }
      if (this.ports.project?.pending(now)) this.enqueue({ kind: "project", priority: 25 });
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: this.settings().timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
      const baseline = this.lastReportCheck || now;
      const baselineTime = new Intl.DateTimeFormat("en-GB", { timeZone: this.settings().timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(baseline);
      const sameDay = windowKeys(now, this.settings().timezone).day === windowKeys(baseline, this.settings().timezone).day;
      if (this.works().length && time >= this.settings().reportTime && (!sameDay || baselineTime < this.settings().reportTime)) this.enqueue({ kind: "report", priority: 10 });
      this.lastReportCheck = now;
      for (const pending of this.jobs()) if (pending.kind === "decision" && !this.decisions.has(pending.id)) this.repository.put("job", { ...pending, status: "done" });
      for (const work of this.works()) if (work.status === "queued" && work.dependsOn.some(id => { const dependency = this.repository.get<CocoWork>("work", id); return !dependency || dependency.status === "cancelled"; })) this.update(work, "to_decide", "A required dependency was cancelled or removed. Decide how this work should continue.");
      const sessions = this.ports.context(this.settings()).sessions;
      for (const work of this.works()) if (work.waitingForSession && work.status === "waiting") {
        const observed = sessions.find(s => s.id === work.observeSessionId);
        if (!observed || ["paused", "cancelled"].includes(observed.status)) this.update({ ...work, waitingForSession: false }, "to_decide", "The observed session was paused, cancelled or removed from CoCo scope");
        else if (observed.status !== "running") this.update({ ...work, waitingForSession: false }, "queued", "Observed turn finished; checking its outcome");
      }
      for (const work of this.works()) if (["queued", "recovering", "verifying"].includes(work.status) && !this.jobs().some(j => j.workId === work.id && j.status !== "done")) this.enqueue({ kind: work.status === "verifying" ? "verify" : work.status === "recovering" ? "recover" : "execute", priority: work.priority, workId: work.id });
    });
    if (enabled && now >= this.heartbeatAt) {
      this.heartbeatAt = now + this.settings().heartbeatMinutes * 60000;
      void this.heartbeat();
    }
    const cooling = this.budget.refresh().cooling;
    const score = (job: CocoJob): number => {
      if (!job.workId || ["decision","followup"].includes(job.kind)) return job.priority;
      const work = this.repository.get<CocoWork>("work",job.workId);
      // Verification sits ahead of inspections (≤40) and reports (≤30).
      return work ? workRank(work, job.at, now) + (job.kind === "verify" ? 50 : 0) : -1;
    };
    const jobs = this.jobs().filter(j=>j.status === "queued" && (j.retryAt??0)<=now).sort((a,b)=>score(b)-score(a)||a.at-b.at);
    const eligible = (job: CocoJob): boolean => {
      if (job.kind === "decision") return this.decisions.has(job.id);
      if (job.kind === "followup") return !this.executionForWork(job.workId) || Boolean(this.repository.get<CocoWork>("work",job.workId!)?.sessionId);
      if (!job.workId) return true;
      const work = this.repository.get<CocoWork>("work",job.workId);
      if (!work) return false;
      const expected = job.kind === "recover" ? "recovering" : job.kind === "verify" ? "verifying" : "queued";
      if (work.status !== expected || (job.kind === "recover" && (work.recoverAt ?? 0) > now)) return false;
      if (job.kind === "execute" && work.budgetHold) return false;
      return work.dependsOn.every(id=>this.repository.get<CocoWork>("work",id)?.status === "completed");
    };
    const started: Promise<void>[] = [];
    if (enabled && !this.conversation) {
      const chat = jobs.find(j=>j.kind === "chat") ?? (!cooling ? jobs.find(j=>j.kind === "autonomous") ?? jobs.find(j=>j.kind === "greet") : undefined);
      if (chat) started.push(this.dispatch(chat));
    }
    if (enabled && !this.deciding) {
      const decision = jobs.find(j=>j.kind === "decision" && (!cooling || this.executions.size > 0) && eligible(j));
      if (decision) started.push(this.dispatch(decision));
    }
    if (enabled && !this.worker) {
      const planning = jobs.find(j=>!CONVERSATION_JOBS.includes(j.kind) && !["execute","decision"].includes(j.kind) && !cooling && eligible(j));
      if (planning) started.push(this.dispatch(planning));
    }
    if (enabled && !cooling) {
      const claimed = new Set<string>();
      const sessions = jobs.some(job => job.kind === "execute" && job.workId) ? this.ports.context(this.settings()).sessions : [];
      for (const job of jobs) {
        if (job.kind !== "execute" || this.active?.workId === job.workId || !eligible(job) || !job.workId) continue;
        const work = this.repository.get<CocoWork>("work", job.workId);
        if (!work || claimed.has(work.workspaceId)) continue;
        // Deployment preflight: rule-generated work waits while a live session
        // turn runs in its project; observing work tracks its own session.
        const automated = work.ruleIds.length > 0 && !work.observeSessionId;
        if (this.workspaceOccupied(work.workspaceId, automated ? sessions : [])) continue;
        claimed.add(work.workspaceId);
        started.push(this.dispatch(job));
      }
    }
    await Promise.all(started);
  }
  /** Budget `reset` handler: clear soft-pauses and re-arm execute without inventing a free continuation turn. */
  private async releaseBudgetHolds(): Promise<void> {
    if (this.releasingHolds) return this.releasingHolds;
    this.releasingHolds = (async () => {
      for (const { id } of this.works().filter(work => work.budgetHold && work.status === "queued")) {
        if (this.stopped || this.budget.cooling() || !this.repository.ownsLease(this.owner, this.now())) return;
        const sessionId = this.repository.get<CocoWork>("work", id)?.sessionId;
        try {
          if (sessionId && this.ports.resumeBudgetHold) await this.ports.resumeBudgetHold(sessionId);
        } catch {
          // Session may already be idle; execute can still continue with resumeSession.
        }
        const work = this.repository.get<CocoWork>("work", id);
        if (!work?.budgetHold || work.status !== "queued") continue;
        this.repository.put("work", { ...work, budgetHold: false, resumeSession: true, updatedAt: this.now() });
        this.enqueue({ kind: "execute", priority: work.priority, workId: work.id });
      }
    })().finally(() => { this.releasingHolds = undefined; this.emit(); });
    return this.releasingHolds;
  }
  private dispatch(job: CocoJob): Promise<void> {
    const running: CocoJob = { ...job,status:"running" }, abort = new AbortController();
    this.repository.put("job",running);
    // Claim the lane before starting async code or callbacks that may wake it.
    let deferred=false;
    const task = Promise.resolve().then(()=>this.perform(job,abort.signal)).catch(error=>{
      if(!abort.signal.aborted && !this.stopped && this.repository.ownsLease(this.owner,this.now()) && isContextCapacityError(error)){
        deferred=true;const attempts=(job.contextRetries??0)+1,delay=Math.min(900000,30000*3**Math.min(attempts-1,4));
        this.repository.put("job",{...job,status:"queued",contextRetries:attempts,retryAt:this.now()+delay});
        if(job.workId){const work=this.repository.get<CocoWork>("work",job.workId);if(work && !["waiting","cancelled","completed"].includes(work.status))this.update({...work,...(job.kind==="recover"?{recoveryAttempts:Math.max(0,(work.recoveryAttempts??1)-1)}:{})},work.status,"Context is being reduced automatically. This operation will retry; no decision is required.");}
        return;
      }
      if(job.kind==="inspect" && job.ruleId && !abort.signal.aborted && !this.stopped && this.repository.ownsLease(this.owner,this.now()) && (job.retries??0)<RULE_RETRY_DELAYS_MS.length && !(error instanceof Error && error.message===NO_FIXED_WORK)){
        deferred=true;const retries=(job.retries??0)+1;
        const retryAt=this.now()+RULE_RETRY_DELAYS_MS[retries-1]!;
        this.repository.put("job",{...job,status:"queued",retries,retryAt});
        this.recordRuleRun(job,{status:"retrying",error:error instanceof Error?error.message:String(error),retryAt});
        return;
      }
      this.decisions.get(job.id)?.reject(error);this.decisions.delete(job.id);
      if (this.stopped || !this.repository.ownsLease(this.owner,this.now())) return;
      if(job.kind==="plan"&&abort.signal.aborted&&this.repository.get<CocoJob>("job",job.id)?.status==="done")return;
      const message = error instanceof Error ? error.message : String(error);
      this.recordRuleRun(job, { status: "failed", error: message, retryAt: undefined, endedAt: this.now() });
      let needsUser = false;
      if (job.workId && job.kind !== "decision") {
        const work = this.repository.get<CocoWork>("work",job.workId);
        if (work && !["waiting","cancelled"].includes(work.status)) {
          if (job.kind === "recover" && work.status === "recovering") this.queueRecovery(work,message);
          else this.update(work,"to_decide",message);
          needsUser = this.repository.get<CocoWork>("work",work.id)?.status === "to_decide";
        }
      } else if (job.kind === "autonomous") console.warn("[coco] autonomous wake failed", message);
      else if (job.kind !== "decision" && job.kind !== "greet") {
        this.message(`CoCo could not complete this request${job.retries ? ` after ${job.retries + 1} attempts` : ""}: ${message}`);
        if(job.kind==="plan")this.ports.notice?.(job.id,`**Planning could not finish**\n\n${message}`);
      }
      if (needsUser) this.ports.notify?.("CoCo · To decide",message);
    }).finally(()=>{
      if (!deferred && !this.stopped && this.repository.ownsLease(this.owner,this.now())) this.repository.put("job",{...job,status:"done"});
      if (CONVERSATION_JOBS.includes(job.kind)) this.conversation=undefined;
      else if (job.kind === "execute") this.clearExecution(job.id);
      else if (job.kind === "decision") this.deciding=undefined;
      else {this.active=undefined;this.abort=undefined;this.worker=undefined;}
      this.emit();
      if (this.stopped && !this.worker && this.executions.size === 0 && !this.conversation && !this.deciding) this.repository.releaseLease(this.owner);
      else if (!this.stopped) queueMicrotask(()=>this.wake());
    });
    if (CONVERSATION_JOBS.includes(job.kind)) this.conversation={job:running,abort,promise:task};
    else if (job.kind === "execute") {
      const workspaceId = this.repository.get<CocoWork>("work", job.workId ?? "")?.workspaceId ?? job.id;
      this.executions.set(workspaceId, { job: running, abort, promise: task });
    }
    else if (job.kind === "decision") this.deciding={job:running,abort,promise:task};
    else {this.active=running;this.abort=abort;this.worker=task;}
    this.emit();
    return task;
  }
  private queueRecovery(work: CocoWork, reason: string, immediate=false): void {
    const attempts = work.recoveryAttempts ?? 0;
    if (attempts >= 3 || !this.ports.recover) {
      this.update(work,"to_decide",`${attempts >= 3 ? "Automatic recovery limit reached. " : ""}${reason}`);
      return;
    }
    const recoverAt = this.now()+(immediate?0:Math.min(30000,1000*2**attempts));
    this.update({...work,recoverAt,recovery:{...work.recovery,reason}},"recovering",`${reason} Automatic recovery ${attempts+1} of 3 is scheduled.`);
  }
  private inScope(rule: CocoRule, workspaceId: string): boolean {
    return inCocoScope(this.settings(), workspaceId, rule);
  }
  canContinueWork(workId: string): boolean {
    const current = this.repository.get<CocoWork>("work", workId);
    if (!current) return false;
    const rank = (work: CocoWork): number => workRank(work, work.createdAt, this.now());
    return !this.works().some(work => work.id !== workId && work.workspaceId === current.workspaceId && work.status === "queued" && work.dependsOn.every(id => this.repository.get<CocoWork>("work", id)?.status === "completed") && rank(work) > rank(current));
  }
  private usage(job: CocoJob): (tokens: number, estimated: boolean, requestId: string) => void {
    return (tokens, estimated, requestId) => {
      if (!Number.isFinite(tokens) || tokens < 0) throw new Error("Invalid model usage");
      this.budget.record({ id: `${job.id}:${requestId}`, tokens, estimated, purpose: job.kind, workId: job.workId });
    };
  }
  private message(text: string, workId?: string, goalId?: string): void { this.repository.put("message", { id: randomUUID(), role: "assistant", text, at: this.now(), ...(workId ? { workId } : {}), ...(goalId ? { goalId } : {}) }); }
  private publishNotice(id: string, text: string): void {
    this.repository.put<CocoMessage>("message", { id: `notice-${id}`, role: "assistant", text, at: this.now(), status: "completed" });
    if (this.ports.chatState?.()) this.ports.notice?.(id, text);
    this.rememberVisitState();
  }
  private rememberVisitState(): void {
    const { fingerprint } = visitWake(this.snapshot(), undefined, this.now(), this.now());
    this.repository.setMeta("visitState", { fingerprint, spokenAt: this.now() });
  }
  private clearQueuedWorkJobs(id: string): void {
    for (const job of this.jobs()) if (job.workId === id && job.status === "queued" && ["execute", "verify", "recover", "followup"].includes(job.kind)) this.repository.put("job", { ...job, status: "done" });
  }
  private acceptChanges(plan: CocoGoalPlan, job: CocoJob): void {
    if (plan.changes?.length && !["chat","plan"].includes(job.kind)) throw new Error("An inspection cannot alter your existing work");
    for (const change of plan.changes ?? []) {
      if (change.action === "revise") {
        const work = this.repository.get<CocoWork>("work", change.workId);
        if (!work || isTerminalWork(work.status)) throw new Error("Finished work cannot be revised");
        const revised = { ...work, objective: change.objective ?? work.objective, steps: change.steps ?? work.steps, acceptance: change.acceptance ?? work.acceptance, revision: work.revision + 1, repairs: 0 };
        const active = Boolean(this.executionForWork(work.id));
        this.update(revised, active ? "executing" : (job.planOnly || plan.planOnly) ? "draft" : "queued", "Plan revised from your chat instruction; previous verification invalidated");
        if (active) this.enqueue({ kind: "followup", priority: 15000, workId: work.id, input: "steer" });
        else this.clearQueuedWorkJobs(work.id);
      } else this.applyWorkCommand({ type: "work", id: change.workId, action: change.action, ...(change.priority !== undefined ? { priority: change.priority } : {}), ...(change.answer ? { answer: change.answer } : {}) });
    }
  }
  private acceptPlan(plan: CocoGoalPlan, job: CocoJob, rule?: CocoRule, reply = true): string[] {
    this.acceptChanges(plan, job);
    // Full autonomy (user decision 2026-11-04): an automatic wake may start new
    // work on its own — only an explicit planOnly request keeps new work a
    // draft. The per-work guards below (no resuming stopped sessions, no
    // bypassing drafts / user decisions) still apply to proactive turns.
    const draft = job.planOnly || plan.planOnly;
    // Rules stay behind the original autonomous gate: an automatic wake still
    // cannot create or activate recurring automation on its own.
    const rulesDraft = draft || job.kind === "autonomous";
    for (const id of plan.activateRuleIds ?? []) {
      const existing = this.repository.get<CocoRule>("rule", id);
      if (rulesDraft || !existing || existing.confirmed || existing.draftOnly) throw new Error("Only previously delegated, unconfirmed rules can be activated automatically");
      if (!this.ports.context(this.settings(), existing).workspaces.length) throw new Error("Rule has no accessible projects");
      if (rule && ((existing.scope.all && !rule.scope.all) || existing.scope.workspaceIds.some(id => !this.inScope(rule, id)) || rule.scope.excludedWorkspaceIds.some(id => existing.scope.all && !existing.scope.excludedWorkspaceIds.includes(id)))) throw new Error("A rule cannot activate automation beyond its own scope");
      this.repository.put("rule", { ...existing, confirmed: true, enabled: true, origin: "coco", nextRunAt: this.nextRuleTime(existing) });
    }
    const ids = new Map<string, string>(plan.work.map(w => [w.key, randomUUID()]));
    const goalId = job.messageId ?? job.ruleId ?? job.id;
    const sessionWork = new Map<string, string>();
    for (const item of plan.work) {
      if (rule && !this.inScope(rule, item.workspaceId)) throw new Error("Generated work exceeds rule scope");
      if (job.kind === "inspect" || job.kind === "autonomous") {
        const session = this.ports.context(this.settings()).sessions.find(s => s.id === (item.executionSessionId ?? item.observeSessionId));
        if (session && ["paused", "cancelled"].includes(session.status)) throw new Error("A proactive inspection cannot resume a user-stopped session");
        if (this.works().some(w => w.workspaceId === item.workspaceId && ["draft","waiting","to_decide","cancelled"].includes(w.status) && ((session && (w.sessionId === session.id || w.observeSessionId === session.id)) || (w.title === item.title && w.objective === item.objective)))) throw new Error("A proactive inspection cannot bypass a draft or a user decision");
      }
      const duplicate = this.works().find(w => (!isTerminalWork(w.status) || (rule?.mode === "inspection" && w.status === "completed" && w.updatedAt >= job.at)) && w.workspaceId === item.workspaceId && ((item.executionSessionId && w.sessionId === item.executionSessionId) || (w.title.trim().toLowerCase() === item.title.trim().toLowerCase() && w.objective.trim() === item.objective.trim())));
      if (duplicate) ids.set(item.key, duplicate.id);
      else if (item.executionSessionId && sessionWork.has(item.executionSessionId)) ids.set(item.key, sessionWork.get(item.executionSessionId)!);
      if (item.executionSessionId) sessionWork.set(item.executionSessionId, ids.get(item.key)!);
    }
    for (const item of plan.work) {
      const id = ids.get(item.key)!;
      const duplicate = this.repository.get<CocoWork>("work", id);
      if (duplicate) {
        const acceptance = [...duplicate.acceptance];
        for (const criterion of [...item.acceptance, ...(rule?.acceptance ?? [])]) if (!acceptance.some(c => c.description === criterion.description && c.kind === criterion.kind && c.path === criterion.path)) acceptance.push({ ...criterion, id: `${id}-${acceptance.length + 1}` });
        const objective = duplicate.objective.includes(item.objective) ? duplicate.objective : `${duplicate.objective}\nAdditional requirement: ${item.objective}`;
        const steps = [...new Set([...duplicate.steps, ...item.steps])];
        const deliverables = [...new Set([...duplicate.deliverables, ...item.deliverables])];
        const dependsOn = [...new Set([...duplicate.dependsOn, ...item.dependsOn.map(key => ids.get(key)!)])].filter(dep => dep !== id);
        const changed = objective !== duplicate.objective || acceptance.length !== duplicate.acceptance.length || steps.length !== duplicate.steps.length || deliverables.length !== duplicate.deliverables.length || dependsOn.length !== duplicate.dependsOn.length;
        const merged: CocoWork = { ...duplicate, objective, acceptance, steps, deliverables, dependsOn, goalIds: [...new Set([...(duplicate.goalIds ?? [duplicate.goalId]), goalId])], ruleIds: [...new Set([...duplicate.ruleIds, ...(rule ? [rule.id] : [])])], revision: duplicate.revision + (changed ? 1 : 0), fullPermissions: true, updatedAt: this.now() };
        this.repository.put("work", merged);
        if (changed && this.executionForWork(id)) this.enqueue({ kind: "followup", priority: 15000, workId: id, input: item.sessionStrategy === "append" ? "append" : "steer" });
        else if (changed && duplicate.status === "completed") this.update(merged, "verifying", "Merged additional criteria; checking the linked session again");
        else if (changed && duplicate.status === "verifying") { this.clearQueuedWorkJobs(id); this.update(merged, "queued", "Requirements updated; continue in the linked session before verification"); }
        continue;
      }
      this.repository.put<CocoWork>("work", { id, goalId, goalIds: [goalId], sessionId: item.executionSessionId, sessionStrategy: item.sessionStrategy, title: item.title, objective: item.objective, workspaceId: item.workspaceId, status: draft ? "draft" : "queued", priority: item.priority, prioritySource: item.userPriority && ["chat","plan"].includes(job.kind) ? "user" : "coco", deadlineAt: item.deadlineAt, dependsOn: item.dependsOn.map(key => ids.get(key)!).filter(dep => dep !== id), steps: item.steps, acceptance: [...item.acceptance, ...(rule?.acceptance.filter(c => !item.acceptance.some(a => a.description === c.description && a.kind === c.kind && a.path === c.path)).map((c, i) => ({ ...c, id: `rule-${i}-${c.id}` })) ?? [])], deliverables: item.deliverables, observeSessionId: item.observeSessionId, ruleIds: rule ? [rule.id] : [], revision: 1, repairs: 0, fullPermissions: true, providerId: rule?.providerId || "", runMode: rule?.runMode ?? "agent", reasoningEffort: rule?.reasoningEffort, createdAt: this.now(), updatedAt: this.now(), summary: "Plan saved with acceptance criteria", timeline: [{ at: this.now(), text: "Planned; acceptance criteria saved before execution" }] });
    }
    const works = new Map(this.works().map(w => [w.id, w]));
    const visiting = new Set<string>(), visited = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error("Merged work dependencies are cyclic");
      if (visited.has(id)) return;
      visiting.add(id); works.get(id)?.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
    };
    for (const id of ids.values()) visit(id);
    for (const suggestion of plan.ruleSuggestions) {
      const scope = rule ? {
        all: rule.scope.all && suggestion.scope.all,
        workspaceIds: (suggestion.scope.all && !rule.scope.all ? rule.scope.workspaceIds : suggestion.scope.workspaceIds).filter(id => this.inScope(rule, id)),
        excludedWorkspaceIds: [...new Set([...suggestion.scope.excludedWorkspaceIds, ...rule.scope.excludedWorkspaceIds])],
      } : suggestion.scope;
      if (!scope.all && !scope.workspaceIds.length) throw new Error("A new rule needs an accessible project within its source scope");
      const scopeKey = (s: CocoRule["scope"]) => JSON.stringify([s.all, [...s.workspaceIds].sort(), [...s.excludedWorkspaceIds].sort()]);
      if (this.rules().some(r => r.objective === suggestion.objective && scopeKey(r.scope) === scopeKey(scope))) continue;
      this.repository.put("rule", { ...suggestion, scope, id: randomUUID(), createdAt: this.now(), origin: "coco", goalId, draftOnly: rulesDraft, confirmed: !rulesDraft, enabled: !rulesDraft && suggestion.enabled, fullPermissions: true, nextRunAt: rulesDraft ? 0 : this.nextRuleTime(suggestion) });
    }
    if (reply && (job.kind === "chat" || plan.work.length || plan.ruleSuggestions.length)) this.message(plan.reply, undefined, job.messageId ?? job.id);
    return [...new Set(ids.values())];
  }
  private async perform(job: CocoJob, signal: AbortSignal): Promise<void> {
    const settings = this.settings(), usage = this.usage(job);
    const guard = (): void => { if (signal.aborted || !this.ownsExecution()) throw new Error("Execution interrupted; review before continuing"); };
    if (job.kind === "greet") {
      const snapshot = this.snapshot();
      if (job.wakeFingerprint && !visitWake(snapshot, this.repository.meta<VisitState | undefined>("visitState", undefined), this.lastInteractionAt(), this.now()).mode) return;
      const background = wakeBackgroundTasks(snapshot.backgroundTasks ?? [], this.now());
      const wake = { mode: job.input, clock: { now: new Date(this.now()).toISOString(), timezone: settings.timezone }, state: snapshot.state, work: snapshot.work.filter(w => snapshot.workspaces.some(p => p.id === w.workspaceId) && w.status !== "cancelled").sort((a,b) => Number(["executing","recovering","verifying","to_decide"].includes(b.status)) - Number(["executing","recovering","verifying","to_decide"].includes(a.status)) || b.updatedAt-a.updatedAt).slice(0,12).map(w => ({ id: w.id, title: w.title, status: w.status, summary: w.summary.slice(0,1000), decision: w.decision?.slice(0,1000), timeline: clipTimeline(w.timeline, 3) })), pendingQuestion: snapshot.chat?.question?.question, pendingApproval: snapshot.chat?.approval?.toolName, planning: snapshot.pendingPlans, background: background.tasks, ...(background.omitted ? { backgroundOmitted: background.omitted } : {}), conversation: this.repository.list<CocoMessage>("message").slice(-8).map(m => ({ role: m.role, text: m.text.slice(0,2000) })) };
      if (this.ports.conversation) {
        const context = this.ports.context(settings);
        const at = this.now();
        await this.ports.conversation({ request: "", wake, context, existingWork: this.modelWork(context), history: this.repository.list<CocoMessage>("message"), planOnly: true }, {
          plan: () => { throw new Error("A visit cannot create new work"); },
          commit: () => { throw new Error("A visit cannot change goals or rules"); },
          publish: (text, status, source) => {
            if ((!text && !source) || !this.repository.ownsLease(this.owner, this.now())) return;
            this.repository.put<CocoMessage>("message", { id: source ? `chat-${source.id}` : `reply-${job.id}`, origin: "wake", role: "assistant", text, at: source?.at ?? at, status });
            if (text.trim() && status !== "error" && job.wakeFingerprint) this.repository.setMeta("visitState", { fingerprint: job.wakeFingerprint, spokenAt: this.now() });
            this.emit();
          },
        }, signal, usage, settings.providerId);
        return;
      }
      const result = await this.ports.model("greet", wake, signal, usage, settings.providerId, job.id) as { markdown?: unknown };
      guard();
      if (typeof result?.markdown !== "string" || !result.markdown.trim()) throw new Error("No greeting was produced");
      this.publishNotice(job.id, result.markdown.trim());
      if (job.wakeFingerprint) this.repository.setMeta("visitState", { fingerprint: job.wakeFingerprint, spokenAt: this.now() });
      return;
    }
    if (job.kind === "autonomous") {
      if (!this.ports.conversation) return;
      const context = this.ports.context(settings), projects = this.wakeProjects(context);
      const current = await this.readVcs(projects);
      guard();
      const entries = undeliveredWakeEntries(this.repository);
      let baseline = this.repository.meta<Record<string, CocoVcsFact>>("vcsBaseline", {});
      const seeded = seedVcsBaseline(baseline, current);
      if (seeded) { this.repository.setMeta("vcsBaseline", seeded); baseline = seeded; }
      const vcs = vcsChanges(projects, baseline, current);
      if (!entries.length && !vcs.length) return;
      const briefing = formatWakeBriefing({
        reasons: wakeReasons(entries, job.input === "heartbeat", vcs.length > 0),
        since: this.repository.meta<number>("lastWakeAt", 0) || undefined,
        timezone: settings.timezone, entries, vcs,
        docNote: entry => this.ports.projectDocNote?.(entry),
      });
      const at = this.now();
      const outcome = await this.ports.conversation({ request: "", autonomous: { briefing }, context, existingWork: this.modelWork(context), history: this.repository.list<CocoMessage>("message"), planOnly: false }, {
        plan: () => { throw new Error("An autonomous wake submits work with coco_work action \"submit\""); },
        commit: raw => { guard(); return this.commitPlan(job, raw); },
        publish: (text, status, source) => {
          if ((!text && !source) || !this.repository.ownsLease(this.owner, this.now())) return;
          this.repository.put<CocoMessage>("message", { id: source ? `chat-${source.id}` : `reply-${job.id}`, role: "assistant", text, at: source?.at ?? at, goalId: job.id, status });
          if (text.trim() && status === "completed") this.rememberVisitState();
          this.emit();
        },
      }, signal, usage, settings.providerId);
      guard();
      // Undelivered facts stay in the ledger for the next wake.
      if (outcome && !outcome.completed) return;
      this.repository.transaction(() => {
        markWakeEntriesDelivered(this.repository, entries.map(e => e.id), this.now());
        this.repository.setMeta("vcsBaseline", nextVcsBaseline(baseline, current, projects));
        this.repository.setMeta("lastWakeAt", at);
      });
      return;
    }
    if (job.kind === "project") {
      if (!this.ports.project) return;
      const outcome = await this.ports.project.run(signal, usage, { main: settings.providerId, fast: settings.fastProviderId || settings.providerId });
      guard();
      outcome.notices.forEach((text, i) => this.publishNotice(`${job.id}-${i}`, text));
      return;
    }
    if(job.kind==="cleanup"){await this.ports.cleanup?.(settings,signal,usage);return;}
    if (job.kind === "decision") {
      const work = this.repository.get<CocoWork>("work", job.workId!);
      if (!work || !this.decisions.has(job.id)) return;
      const question: unknown = JSON.parse(job.input!);
      const providerId = settings.fastProviderId || settings.providerId;
      const result = this.ports.decide
        ? await this.ports.decide({ work, question }, signal, usage, providerId)
        : await this.ports.model("decide", { work, question }, signal, usage, providerId, job.id);
      guard();
      this.decisions.get(job.id)?.resolve(result); this.decisions.delete(job.id);
      return;
    }
    if (job.kind === "followup") {
      const work = this.repository.get<CocoWork>("work", job.workId!);
      if (!work || ["cancelled", "completed", "waiting", "to_decide"].includes(work.status)) return;
      if (this.executionForWork(work.id) && work.sessionId && this.ports.followup) {
        await this.ports.followup(work, job.input === "append" ? "append" : "steer");
        guard();
      } else {
        this.update(work, "queued", "Updated instructions will continue in the linked session");
        for (const pending of this.jobs()) if (pending.workId === work.id && pending.kind === "verify" && pending.status === "queued") this.repository.put("job", { ...pending, status: "done" });
      }
      return;
    }
    if (job.kind === "chat" || job.kind === "plan" || job.kind === "inspect") {
      const rule = job.ruleId ? this.repository.get<CocoRule>("rule", job.ruleId) : undefined;
      if (job.ruleId && (!rule?.enabled || !rule.confirmed)) return;
      this.recordRuleRun(job, { status: "running", error: undefined, retryAt: undefined, endedAt: undefined });
      const context = this.ports.context(settings, rule);
      if (job.input && !context.workspaces.some(w => w.id === job.input)) throw new Error("Selected project is excluded or unavailable");
      const message = job.messageId ? this.repository.get<CocoMessage>("message", job.messageId) : undefined;
      const reference = message?.workId ? this.repository.get<CocoWork>("work", message.workId) : undefined;
      if (reference && !context.workspaces.some(w => w.id === reference.workspaceId)) throw new Error("Referenced work is excluded");
      if (job.kind === "chat" && this.ports.conversation) {
        const replyId = `reply-${job.id}`, at = this.now();
        await this.ports.conversation({ request: message!.text, reference, context, existingWork: this.modelWork(context), planOnly: job.planOnly === true, continuation: job.continuation, preferredWorkspaceId: job.input, ...(job.handoverInstruction ? { handoverInstruction: job.handoverInstruction } : {}), history: this.repository.list<CocoMessage>("message").slice(0, this.repository.list<CocoMessage>("message").findIndex(m => m.id === job.messageId)) }, {
          plan: raw => {
            guard();
            if(!raw || typeof raw!=="object"||Array.isArray(raw))throw new Error("A planning request must be an object");
            const args=raw as {action?:unknown;objective?:unknown;workspaceId?:unknown;planOnly?:unknown;requestId?:unknown};
            if(args.action==="cancel"){
              if(typeof args.requestId!=="string" || !this.jobs().some(j=>j.kind==="plan"&&j.messageId===args.requestId))throw new Error("This planning request is no longer current");
              this.command({type:"goal",id:args.requestId,action:"cancel"});return {requestId:args.requestId,queued:false};
            }
            if(args.action!==undefined&&args.action!=="plan")throw new Error("Unknown planning action");
            if(typeof args.objective!=="string"||!args.objective.trim()||args.objective.length>20000)throw new Error("Provide a goal of at most 20,000 characters");
            if(args.planOnly!==undefined&&typeof args.planOnly!=="boolean")throw new Error("Invalid plan-only instruction");
            const live=this.ports.context(this.settings());
            if(args.workspaceId!==undefined&&(typeof args.workspaceId!=="string"||!live.workspaces.some(w=>w.id===args.workspaceId)))throw new Error("Planning project is excluded or unavailable");
            const existing=this.repository.list<CocoJob>("job").find(j=>j.kind==="plan"&&j.messageId===job.messageId);
            if(existing)return {requestId:job.messageId!,queued:existing.status!=="done"};
            this.enqueue({kind:"plan",priority:80,messageId:job.messageId,planPrompt:args.objective.trim(),input:typeof args.workspaceId==="string"?args.workspaceId:job.input,planOnly:job.planOnly===true||args.planOnly===true});
            this.emit();this.wake();return {requestId:job.messageId!,queued:true};
          },
          commit: raw => { guard(); return this.commitPlan(job, raw); },
          rule: raw => { guard(); return this.changeRule(raw); },
          publish: (text, status, source) => {
            if (!text && !source) return;
            if (!this.repository.ownsLease(this.owner, this.now())) return;
            this.repository.put<CocoMessage>("message", { id: source ? `chat-${source.id}` : replyId, role: "assistant", text, at: source?.at ?? at, goalId: job.messageId ?? job.id, status });
            if (text.trim() && status === "completed") this.rememberVisitState();
            this.emit();
          },
        }, signal, usage, settings.providerId);
        return;
      }
      const result = await this.ports.model("plan", { clock: { now: new Date(this.now()).toISOString(), timezone: settings.timezone }, request: job.planPrompt ?? message?.text ?? rule?.objective, originalUserRequest:message?.text, mode: rule?.mode, planOnly: job.planOnly, preferredWorkspaceId: job.input, reference, context, existingWork: this.modelWork(context), rules: this.rules().filter(r => r.scope.all || r.scope.workspaceIds.some(id => context.workspaces.some(w => w.id === id))), conversation: rule ? [] : this.repository.list<CocoMessage>("message").filter(m => m.at >= this.repository.meta("contextSince", 0)).slice(-12), rule }, signal, usage, rule?.providerId || settings.providerId, job.id);
      guard();
      const plan = validatePlan(result, new Set(context.workspaces.map(w => w.id)), new Set(context.sessions.map(s => s.id)), new Set(this.works().filter(w => context.workspaces.some(p => p.id === w.workspaceId)).map(w => w.id)), new Map(context.sessions.map(s => [s.id, s.workspaceId])));
      if (job.kind === "inspect" && rule?.mode === "fixed" && !plan.work.length) throw new Error(NO_FIXED_WORK);
      this.repository.transaction(() => { const workIds = this.acceptPlan(plan, job, rule); this.recordRuleRun(job, { status: workIds.length ? "planned" : "no_action", summary: plan.reply, workIds, endedAt: this.now() }); });
      if(job.kind==="plan")this.ports.notice?.(job.id,`${plan.work.length||plan.ruleSuggestions.length?"**Plan ready**":"**Planning needs your input**"}\n\n${plan.reply}`);
      return;
    }
    if (job.kind === "report") {
      const context = this.ports.context(settings);
      const work = this.works().filter(w => context.workspaces.some(p => p.id === w.workspaceId));
      const result = await this.ports.model("report", { work, verifications: this.repository.list<CocoVerification>("verification").filter(v => work.some(w => w.id === v.workId)), since: this.now() - 86400000 }, signal, usage, settings.providerId, job.id);
      guard();
      if (!result || typeof result !== "object" || typeof (result as { markdown?: unknown }).markdown !== "string") throw new Error("Invalid report output");
      this.repository.put<CocoReport>("report", { id: randomUUID(), at: this.now(), title: `CoCo · ${windowKeys(this.now(), settings.timezone).day}`, markdown: (result as { markdown: string }).markdown.slice(0, 100000), workIds: work.map(w => w.id) });
      this.ports.notify?.("CoCo · Daily report", "Your consolidated work report is ready.");
      return;
    }
    if (job.kind === "recover") {
      let work = this.repository.get<CocoWork>("work",job.workId!);
      if (!work || work.status !== "recovering" || !this.ports.recover) return;
      if ((work.recoveryAttempts ?? 0) >= 3) { this.update(work,"to_decide","Automatic recovery limit reached. Review the saved task before trying again."); return; }
      work = this.update({...work,recoveryAttempts:(work.recoveryAttempts??0)+1},"recovering",`Reviewing the interrupted task (attempt ${(work.recoveryAttempts??0)+1} of 3). See the recovery card in Chat for live progress.`);
      const revision=work.revision;
      const result = await this.ports.recover(work,settings,signal,usage);
      guard();
      const current=this.repository.get<CocoWork>("work",work.id);
      if (!current || current.revision !== revision || current.status !== "recovering") return;
      const recovered={...current,recoverAt:undefined,recovery:{reason:result.summary,turnId:result.turnId,uncertainEffects:result.uncertainEffects}};
      if(result.action === "resume" && !result.uncertainEffects) this.update({...recovered,resumeSession:true},"queued",`Resuming the existing session. ${result.summary}`);
      else if(result.action === "verify") this.update(recovered,"verifying",`Checking saved results before more execution. ${result.summary}`);
      else this.update(recovered,result.action === "wait"?"waiting":"to_decide",result.summary);
      return;
    }
    let work = this.repository.get<CocoWork>("work", job.workId!);
    if (!work || work.status !== (job.kind === "execute" ? "queued" : "verifying")) return;
    const context = this.ports.context(settings);
    if (!context.workspaces.some(w => w.id === work!.workspaceId)) throw new Error("Work scope was excluded or removed");
    for (const id of work.ruleIds) {
      const rule = this.repository.get<CocoRule>("rule", id);
      if (!ruleAuthorizes(rule, work!.workspaceId)) throw new Error("A source rule was disabled, removed or restricted");
    }
    if (work.observeSessionId) {
      const observed = context.sessions.find(s => s.id === work!.observeSessionId && s.workspaceId === work!.workspaceId);
      if (!observed) throw new Error("Observed session is excluded or unavailable");
      if (observed.status === "running") { this.repository.put("work", { ...work, status: "waiting", waitingForSession: true, summary: "Observing the current user turn" }); return; } // Job remains eligible via queued work on the next tick.
      if (["paused", "cancelled"].includes(observed.status)) throw new Error("Existing work was paused or cancelled by you");
    }
    if (job.kind === "execute") {
      if (work.observeSessionId && work.repairs > 0 && !work.sessionId) work = { ...work, sessionId: work.observeSessionId };
      work = this.update(work, "executing", work.repairs ? `Repair ${work.repairs} of ${settings.repairLimit}` : "Executing the saved plan");
      const attempt = this.repository.put<CocoAttempt>("attempt", { id: randomUUID(), workId: work.id, revision: work.revision, startedAt: this.now(), status: "running" });
      try {
        const result = await this.ports.execute(work, settings, signal, usage, id => {
          guard();
          work = this.repository.put("work", { ...this.repository.get<CocoWork>("work", work!.id)!, sessionId: id, resumeSession: false });
          this.repository.put("attempt", { ...attempt, sessionId: id });
          this.emit();
        });
        guard();
        work = this.repository.get<CocoWork>("work", work.id)!;
        this.repository.put("attempt", { ...attempt, resultRevision: work.revision, sessionId: work.sessionId, status: result.interrupted ? "interrupted" : "finished", endedAt: this.now(), summary: result.summary });
        if (!result.interrupted && !result.paused && !result.deferred && !result.waiting) {
          await this.ports.captureResults?.(work.id);
          guard();
          work = this.repository.get<CocoWork>("work", work.id)!;
        }
        if (work.status !== "executing") return;
        this.repository.transaction(() => {
          if (result.interrupted) this.queueRecovery(work!,result.interrupted);
          else if (result.paused) this.update({ ...work!, budgetHold: false },"waiting",result.paused);
          else if (result.deferred) this.update({ ...work!, ...(result.budgetHold ? { budgetHold: true, resumeSession: true } : { budgetHold: false }) }, "queued", result.summary);
          else if (result.waiting) this.update({ ...work!, budgetHold: false }, "to_decide", result.waiting, result.decisionPrompt ?? null);
          else { this.update({...work!,recovery:undefined,recoveryAttempts:0,budgetHold:false}, "verifying", "Execution finished; checking acceptance evidence"); this.enqueue({ kind: "verify", workId: work!.id, priority: work!.priority }); }
        });
        if (result.waiting) this.ports.notify?.("CoCo · To decide", result.waiting);
      } catch (error) {
        this.repository.put("attempt", { ...attempt, sessionId: work.sessionId, status: signal.aborted ? "interrupted" : "failed", endedAt: this.now() });
        if(isContextCapacityError(error))throw error;
        if (!signal.aborted && work.sessionId && this.ports.recover) this.queueRecovery(this.repository.get<CocoWork>("work",work.id)!,error instanceof Error?error.message:String(error));
        else throw error;
      }
      return;
    }
    const result = await this.ports.model("verify", { work }, signal, usage, settings.fastProviderId || work.providerId || settings.providerId, job.id);
    guard();
    const current = this.repository.get<CocoWork>("work", work.id);
    if (!current || current.revision !== work.revision || current.status !== "verifying") return;
    const decision = verifyDecision(result, Boolean(work.recovery?.uncertainEffects));
    const latest = this.repository.get<CocoWork>("work", work.id);
    if (!latest || latest.revision !== work.revision || latest.status !== "verifying") return;
    const reason = decision.reason;
    const snapshot: CocoWork = work;
    const record = (passed: boolean, summary: string): void => {
      this.repository.put<CocoVerification>("verification", { id: randomUUID(), workId: snapshot.id, revision: snapshot.revision, sessionId: snapshot.sessionId, at: this.now(), passed, summary, checks: [{ criterionId: "task", passed, evidence: summary }], criteria: snapshot.acceptance, objective: snapshot.objective, evidenceDigest: createHash("sha256").update(summary).digest("hex") });
    };
    const ask = (question: string): void => {
      record(false, question);
      this.update({ ...snapshot, advanceOnAnswer: true, advancePrompt: undefined }, "to_decide", question, { question, options: [], allowCustom: true });
    };
    this.repository.transaction(() => {
      if (decision.action === "complete") {
        record(true, reason);
        this.update({ ...snapshot, advancePrompt: undefined, advanceOnAnswer: false, recovery: undefined, recoveryAttempts: 0, budgetHold: false }, "completed", reason);
        return;
      }
      if (decision.action === "needs_user") {
        ask(decision.question || reason);
        return;
      }
      const prompt = decision.prompt || "";
      const prior = this.repository.list<CocoVerification>("verification").filter(v => v.workId === snapshot.id && !v.passed);
      if (snapshot.repairs >= settings.repairLimit) ask(`Automatic continuation limit reached. ${reason}`);
      else if (prior.at(-1)?.summary === prompt) ask(`No new progress after the last continuation. ${reason}`);
      else {
        record(false, prompt);
        this.update({ ...snapshot, repairs: snapshot.repairs + 1, advancePrompt: prompt, advanceOnAnswer: false, recovery: undefined, budgetHold: false }, "queued", prompt);
        this.enqueue({ kind: "execute", workId: snapshot.id, priority: snapshot.priority });
      }
    });
    const settled = this.repository.get<CocoWork>("work", work.id);
    if (settled?.status === "completed") this.ports.notify?.("CoCo · Work verified", work.title);
    else if (settled?.status === "to_decide") this.ports.notify?.("CoCo · To decide", settled.decision || work.title);
  }
}
