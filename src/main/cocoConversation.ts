import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveClient, type SessionStore } from "./sessionRuntime.js";
import type { CocoRepository } from "../coco/repository.js";
import type { CocoContext, CocoPorts } from "../coco/engine.js";
import type { CocoChatControl, CocoChatState, CocoMessage, CocoRule, CocoSettings, CocoWork } from "../coco/types.js";
import { registerCocoExecution } from "../coco/executionAccess.js";
import { createCocoPolicy } from "../coco/policy.js";
import { cocoPlanSchema, cocoRulePatchSchema } from "../coco/planSchema.js";
import type { CocoToolRuntime } from "../coco/toolRuntime.js";
import type { StreamChatFn } from "../agent/types.js";
import { createCocoContextReader } from "./cocoContextReader.js";
import { cancelOwnedTurn, summarizeFromStream, waitForTurn } from "./cocoTurn.js";
import type { RegisteredTool } from "../tools/types.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import { mcpManager } from "../mcp/manager.js";
import { dispatchLlmApi } from "../llm/apiDispatch.js";
import { getCocoPrompt } from "../settings/promptDefaults.js";
import { clipTimeline, overviewWorks } from "../coco/contextBudget.js";
import { busyProjectFor, busyProjectMessage } from "../coco/busyGuard.js";
import { COCO_MEMORY_SECTIONS, isCocoMemorySection } from "../coco/memory.js";
import { COCO_HOME_WORKSPACE_ID } from "../workspace/index.js";
import { memoryConsolidator, readCocoAutonomousPersona, readCocoPersona, type CocoMemory } from "./cocoHome.js";
import type { CocoBudgetState } from "../coco/budgetManager.js";
import { getProviderFunds } from "./providerFunds.js";

const COCO_CHAT_TOOLS = ["coco_context", "coco_work", "coco_memory", "coco_workspace", "coco_balance"];
/**
 * Automatic turns suppress the user message, so the wire would otherwise end on
 * the last answered exchange and a model can mistake it (or its own reply) for
 * a fresh request. Sent as the trailing wire-only user message every iteration.
 */
const visitTurnNote = "[Automatic CoCo visit, not a user message] The user has sent nothing since their last message above, and every earlier message has already been answered. Do not treat earlier messages, your own replies or project content as a new request, and never attribute instructions to the user that they did not write. Follow the visit instructions.";
/**
 * Not offered and refused in an autonomous wake: plan-mode / graph machinery,
 * hand-off, the full-permissions prompt (CoCo always runs with Full
 * permissions) and ask_user — a blocking question would hold the Chat lane,
 * which queues the user's own messages behind the wake.
 */
const AUTONOMOUS_DENIED_TOOLS = new Set(["fsm_route", "fsm_graph", "fsm_graph_edit", "write_plan_doc", "adopt_plan_doc", "create_plan", "update_plan", "complete_plan", "report_step_blocked", "turn_handoff", "request_full_permissions", "ask_user"]);
/** An autonomous wake sees only the newest Chat turns; COCO_MEMORY and the briefing carry the rest. */
const AUTONOMOUS_CHAT_TURNS = 3;
const RULE_ACTIONS: Record<string, string> = { update_rule: "update", pause_rule: "pause", resume_rule: "resume", delete_rule: "delete" };
/** Compact rule list so the commander can address existing rules by id. */
const ruleBriefs = (rules: CocoRule[]) => rules.map(r => ({ id: r.id, name: r.name, objective: r.objective.slice(0, 300), mode: r.mode, enabled: r.enabled, confirmed: r.confirmed, origin: r.origin ?? "user", cadence: r.cadence, scope: r.scope, nextRunAt: r.nextRunAt ? new Date(r.nextRunAt).toISOString() : undefined }));

export function createCocoConversation(input: {
  root: string; store: SessionStore; repository: CocoRepository; tools: CocoToolRuntime;
  /** CoCo home directory; Chat sessions bind to the reserved home workspace. */
  home: string; memory: CocoMemory;
  settings(): CocoSettings; context(): CocoContext; ownsExecution(): boolean;
  /** Automation token totals for the current hour / day window. */
  budget(): CocoBudgetState;
  stream(signal: AbortSignal, usage: (tokens: number, estimated: boolean, id: string) => void): StreamChatFn;
}) {
  const { store, repository } = input;
  const planningRequests = () => repository.pending<{kind:string;messageId?:string;planPrompt?:string;status:string}>("job").filter(j=>j.kind==="plan").map(j=>({requestId:j.messageId,objective:j.planPrompt,status:j.status}));
  const status = (): Omit<CocoChatState, "textOnlyMessageIds" | "turnStartMessageIds"> | undefined => {
    const id = repository.meta<string>("chatSessionId", "");
    if (!id) return undefined;
    const session = store.getSessionSummary(id);
    if (!session || session.source !== "coco_chat") return undefined;
    const question = store.listPendingUserAsks(id)[0], approval = store.listPendingToolApprovals(id)[0];
    if (question || approval) return { sessionId: id, status: session.status, ...(question ? { question } : {}), ...(approval ? { approval } : {}) };
    // Handed-over sessions: a needs_user decision parks the ask for this
    // card (FIFO, one at a time), labeled with the originating session.
    for (const parked of store.listCocoParkedRequests()) {
      const title = store.getSessionSummary(parked.sessionId)?.title;
      const label = title ? { onBehalfOf: title } : {};
      if (parked.kind === "ask") {
        const payload = store.listPendingUserAsks(parked.sessionId).find(q => q.requestId === parked.requestId);
        if (payload) return { sessionId: id, status: session.status, question: { ...payload, ...label } };
      } else {
        const payload = store.listPendingToolApprovals(parked.sessionId).find(a => a.requestId === parked.requestId);
        if (payload) return { sessionId: id, status: session.status, approval: { ...payload, ...label } };
      }
    }
    return { sessionId: id, status: session.status };
  };
  const state = (): CocoChatState | undefined => {
    const chat = status();
    if (!chat) return undefined;
    // Older native greetings predate the origin field. Their projection IDs
    // have no goal link; ordinary Chat replies always carry a goalId.
    const textOnlyMessageIds = repository.list<CocoMessage>("message").filter(m => m.role === "assistant" && m.id.startsWith("chat-") && (m.origin === "wake" || !m.goalId)).map(m => m.id.slice(5));
    return { textOnlyMessageIds: [...textOnlyMessageIds, ...repository.meta<string[]>("silentChatMessageIds", [])], turnStartMessageIds: repository.meta<string[]>("chatTurnStartIds", []), ...chat };
  };
  const flushNotices = (): void => {
    const id=repository.meta<string>("chatSessionId","");if(!id || store.isTurnActive(id))return;
    for(const notice of repository.list<{id:string;text:string;status:string;contextSince:number}>("chatNotice").filter(n=>n.status==="pending")){
      if(notice.contextSince!==repository.meta<number>("contextSince",0)){repository.put("chatNotice",{...notice,status:"discarded"});continue;}
      if(store.appendCocoChatNotice(id,`coco-notice-${notice.id}`,notice.text))repository.put("chatNotice",{...notice,status:"delivered"});
    }
  };
  const notice = (id:string,text:string):void => {
    if(repository.get("chatNotice",id))return;
    repository.put("chatNotice",{id,text,status:"pending",contextSince:repository.meta<number>("contextSince",0)});flushNotices();
  };
  const control = (command: CocoChatControl): void => {
    const chat = state(); if (!chat) throw new Error("CoCo Chat is unavailable");
    if (command.action === "answer") {
      const q = chat.question;
      if (!q || q.requestId !== command.requestId) throw new Error("This CoCo question is no longer current");
      const labels = command.selections ?? [command.selected];
      if (!labels.length || labels.some(s => typeof s !== "string" || !s.trim() || s.length > 20000) || (labels.length > 1 && !q.allowMultiple) || (!command.custom && labels.some(s => !q.options.includes(s))) || (command.custom && q.options.length > 0 && !q.allowCustom)) throw new Error("Choose one of the current options or provide an allowed answer");
      if (!store.respondUserAsk({ requestId: q.requestId, selected: command.selected, ...(command.selections ? { selections: command.selections } : {}), custom: command.custom })) throw new Error("CoCo could not apply this answer");
    } else if (command.action === "approval") {
      if (!chat.approval || chat.approval.requestId !== command.requestId || !store.respondToolApproval({ requestId: command.requestId, approved: command.approved })) throw new Error("This CoCo tool confirmation is no longer current");
    }
  };
  const converse: NonNullable<CocoPorts["conversation"]> = async (request, callbacks, signal, usage, providerId) => {
    flushNotices();
    const settings = input.settings(), context = input.context();
    const denied = store.listWorkspaces().filter(w => settings.excludedWorkspaceIds.includes(w.id)).map(w => w.path);
    const contextSince = repository.meta<number>("contextSince", 0);
    const oldId = repository.meta<string>("chatSessionId", "");
    const old = oldId ? store.getSessionTail(oldId, { turns: 1 })?.session : undefined;
    const reusable = old?.source === "coco_chat" && old.workspaceId === COCO_HOME_WORKSPACE_ID && repository.meta<number>("chatContextSince", 0) === contextSince;
    const workspace = { id: COCO_HOME_WORKSPACE_ID, path: input.home };
    let sessionId = reusable ? oldId : "";
    const before = new Set((reusable ? store.getSessionTail(oldId, { turns: 1 })?.session.messages : [])?.map(m => m.id) ?? []);
    const valid = (): boolean => input.ownsExecution() && !signal.aborted && JSON.stringify(input.settings().excludedWorkspaceIds) === JSON.stringify(settings.excludedWorkspaceIds) && JSON.stringify(store.listWorkspaces().filter(w => input.settings().excludedWorkspaceIds.includes(w.id)).map(w => w.path)) === JSON.stringify(denied);
    const policy = createCocoPolicy(workspace.path, denied, true, valid, { fullAccess: true });
    const readContext = createCocoContextReader({ store, repository, allowed: input.context, valid });
    const result = (value: unknown) => ({ returnCode: ToolReturnCode.Success, content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    const consolidate = memoryConsolidator({ root: input.root, home: input.home, providerId, signal, stream: input.stream(signal, usage) });
    const autonomous = request.autonomous;
    const cocoWorkDefinition: RegisteredTool["definition"] = autonomous
      ? { name: "coco_work", description: "Save CoCo work with action \"submit\" and a `plan`. Changes to existing work (by id) merge directly; new work items start immediately. Rule suggestions are kept as drafts until the user starts them. Validation errors come back as tool feedback.", defaultPermissionLevel: 0, parameters: { type: "object", properties: { action: { type: "string", enum: ["submit"] }, plan: cocoPlanSchema }, required: ["action", "plan"] } }
      : { name: "coco_work", description: "Manage CoCo work and rules. submit: save `plan` (executable work, changes to existing work, new rules); validation errors come back as tool feedback. plan: hand `objective` to background planning and return immediately (do not decompose large goals in Chat). cancel_planning: cancel the planning request `requestId`, only when the user asks. update_rule / pause_rule / resume_rule / delete_rule: change an existing rule; pass its `id` from the listed rules as the top-level `ruleId` (not inside `rule`, not the rule name). update takes only the fields to change in `rule`; omitted fields stay. Never use this for ordinary conversational replies.", defaultPermissionLevel: 0, parameters: { type: "object", properties: { action: { type: "string", enum: ["submit", "plan", "cancel_planning", "update_rule", "pause_rule", "resume_rule", "delete_rule"] }, plan: cocoPlanSchema, objective: { type: "string" }, workspaceId: { type: "string" }, planOnly: { type: "boolean" }, requestId: { type: "string" }, ruleId: { type: "string", description: "Rule id (UUID) from the listed rules; required for *_rule actions." }, rule: cocoRulePatchSchema }, required: ["action"] } };
    const localTools: RegisteredTool[] = [{
      definition: { name: "coco_context", description: "Read current CoCo project/session/work summaries, or relevant scoped session/file content. Omit arguments for a compact overview (work fields are clipped); pass workspaceId with workId for full work details, or with sessionId for the session's newest turns (text and tool I/O clipped).", defaultPermissionLevel: 0, parameters: { type: "object", properties: { workspaceId: { type: "string" }, sessionId: { type: "string" }, workId: { type: "string" }, path: { type: "string" }, query: { type: "string" } } } },
      execute: async args => {
        signal.throwIfAborted();
        if (!args.workspaceId) { const live = input.context(); const { works, omitted } = overviewWorks(repository.list<CocoWork>("work").filter(w => live.workspaces.some(p => p.id === w.workspaceId))); return result({ ...live, planningRequests: planningRequests(), rules: ruleBriefs(repository.list<CocoRule>("rule")), existingWork: works, ...(omitted ? { existingWorkOmitted: omitted } : {}) }); }
        return result(await readContext(args));
      },
    }, {
      definition: cocoWorkDefinition,
      execute: async args => {
        signal.throwIfAborted();
        if (args.action === "submit") {
          if (!args.plan || typeof args.plan !== "object" || Array.isArray(args.plan)) return { returnCode: ToolReturnCode.InvalidArguments, content: [{ type: "text" as const, text: "submit needs a `plan` object." }] };
          const drafted = callbacks.commit(args.plan)?.drafted ?? 0;
          return result({ saved: true, message: drafted
            ? `The validated plan was saved. ${drafted} new work item(s) were kept as drafts because the request was planOnly. Tell the user they are waiting for Start work; do not describe them as dispatched.`
            : "The validated plan was saved. Describe the result normally; execution and acceptance are tracked separately." });
        }
        if (args.action === "plan") return result(callbacks.plan({ action: "plan", objective: args.objective, workspaceId: args.workspaceId, planOnly: args.planOnly }));
        if (args.action === "cancel_planning") return result(callbacks.plan({ action: "cancel", requestId: args.requestId }));
        const ruleAction = typeof args.action === "string" ? RULE_ACTIONS[args.action] : undefined;
        if (ruleAction) {
          if (!callbacks.rule) return { returnCode: ToolReturnCode.PermissionDenied, content: [{ type: "text" as const, text: "Rules can only be changed in a Chat turn with the user." }] };
          return result(callbacks.rule({ action: ruleAction, ruleId: args.ruleId, rule: args.rule }));
        }
        return { returnCode: ToolReturnCode.InvalidArguments, content: [{ type: "text" as const, text: "action must be submit | plan | cancel_planning | update_rule | pause_rule | resume_rule | delete_rule." }] };
      },
    }, {
      definition: { name: "coco_memory", description: "Read or update CoCo's durable memory (COCO_MEMORY.md, already shown as [COCO_MEMORY]), or search archived older entries. update: section + content (one '- ' bullet per line); merge appends, replace rewrites the section. Work log bullets are timestamped automatically. Over the size limit, older entries are summarized and archived; search_archive recalls them.", defaultPermissionLevel: 0, parameters: { type: "object", properties: { action: { type: "string", enum: ["read", "update", "search_archive"] }, section: { type: "string", enum: [...COCO_MEMORY_SECTIONS] }, content: { type: "string" }, mode: { type: "string", enum: ["merge", "replace"] }, query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["action"] } },
      execute: async args => {
        signal.throwIfAborted();
        if (args.action === "read") return result({ path: input.memory.path, body: await input.memory.read() });
        if (args.action === "search_archive") {
          if (typeof args.query !== "string" || !args.query.trim()) return { returnCode: ToolReturnCode.InvalidArguments, content: [{ type: "text" as const, text: "search_archive needs a non-empty query." }] };
          return result({ entries: input.memory.searchArchive(args.query, typeof args.limit === "number" ? args.limit : 10) });
        }
        if (args.action !== "update" || !isCocoMemorySection(args.section) || typeof args.content !== "string" || !args.content.trim()) return { returnCode: ToolReturnCode.InvalidArguments, content: [{ type: "text" as const, text: `update needs section (${COCO_MEMORY_SECTIONS.join(" | ")}) and non-empty content.` }] };
        return result(await input.memory.update({ section: args.section, content: args.content, mode: args.mode === "replace" ? "replace" : "merge" }, consolidate));
      },
    }, {
      definition: { name: "coco_workspace", description: "Create or list workspaces (projects). create: register the folder at absolute `path` as workspace `name` — a missing folder is created (mkdir -p); an existing empty folder or git repository registers as-is; an existing non-empty non-git folder is refused. Idempotent: a known path returns the existing workspace with existing:true. The new project enters the CoCo scope immediately; work submitted for it starts without waiting for the user. list: current CoCo workspaces with their origin.", defaultPermissionLevel: 0, parameters: { type: "object", properties: { action: { type: "string", enum: ["create", "list"] }, name: { type: "string", description: "Workspace name (create only)" }, path: { type: "string", description: "Absolute folder path (create only)" } }, required: ["action"] } },
      execute: async args => {
        signal.throwIfAborted();
        if (args.action === "list") {
          const inScope = new Set(input.context().workspaces.map(w => w.id));
          return result({ workspaces: store.listWorkspaces().filter(w => inScope.has(w.id)).map(w => ({ id: w.id, name: w.name, path: w.path, origin: w.origin })) });
        }
        if (args.action !== "create") return { returnCode: ToolReturnCode.InvalidArguments, content: [{ type: "text" as const, text: "action must be create | list." }] };
        const name = typeof args.name === "string" ? args.name.trim() : "";
        const rawPath = typeof args.path === "string" ? args.path.trim() : "";
        if (!name) return { returnCode: ToolReturnCode.InvalidArguments, content: [{ type: "text" as const, text: "create needs a non-empty workspace name." }] };
        if (!rawPath) return { returnCode: ToolReturnCode.InvalidArguments, content: [{ type: "text" as const, text: "create needs a folder path." }] };
        if (!rawPath.startsWith("/")) return { returnCode: ToolReturnCode.InvalidArguments, content: [{ type: "text" as const, text: "path must be an absolute folder path." }] };
        const normalized = resolve(rawPath);
        const known = store.listWorkspaces().find(w => resolve(w.path) === normalized);
        if (known) return result({ id: known.id, name: known.name, path: known.path, origin: known.origin, existing: true });
        try {
          const st = await stat(normalized).catch(() => null);
          if (st && !st.isDirectory()) return { returnCode: ToolReturnCode.InvalidArguments, content: [{ type: "text" as const, text: "path exists and is not a folder." }] };
          if (st) {
            // Accident guard: a folder with real content and no git marker is
            // presumed user data; registering it must stay a human decision.
            const entries = (await readdir(normalized).catch(() => null))?.filter(e => e !== ".DS_Store") ?? null;
            const gitMarker = await stat(join(normalized, ".git")).catch(() => null);
            if (entries && entries.length > 0 && !gitMarker) return { returnCode: ToolReturnCode.PermissionDenied, content: [{ type: "text" as const, text: "This folder is not empty and is not a git repository. Ask the user to register it from New Project on the Mac, or create a fresh folder." }] };
          } else {
            await mkdir(normalized, { recursive: true });
          }
        } catch (err) {
          return { returnCode: ToolReturnCode.GenericFailure, content: [{ type: "text" as const, text: `Cannot create folder: ${err instanceof Error ? err.message : String(err)}` }] };
        }
        const ws = await store.createWorkspace({ name, path: normalized, origin: "coco" });
        return result({ id: ws.id, name: ws.name, path: ws.path, origin: ws.origin, existing: false });
      },
    }, {
      definition: { name: "coco_balance", description: "Read-only spending headroom. Returns CoCo's automation token budget (used / limit for the current hour and day, cooldown), every configured model provider with its account balance line, and subscription usage bars (5h / weekly / monthly quotas) for supported providers. balance null = the provider has no balance API, no API key, or the query failed — unknown, not zero. Usage is cached for 60 s; refresh:true forces a new query.", defaultPermissionLevel: 0, parameters: { type: "object", properties: { refresh: { type: "boolean" } } } },
      execute: async args => {
        signal.throwIfAborted();
        const s = input.settings(), b = input.budget();
        const automation = { hourly: { used: b.hourly, limit: s.hourlyTokens }, daily: { used: b.daily, limit: s.dailyTokens }, estimated: b.estimated, cooling: b.cooling, ...(b.resumeAt ? { resumeAt: new Date(b.resumeAt).toISOString() } : {}), timezone: s.timezone, note: "Chat turns with the user are not counted against this budget." };
        try {
          const funds = await getProviderFunds(input.root, { force: args.refresh === true });
          signal.throwIfAborted();
          return result({ automation, cocoProviders: { main: s.providerId || null, decision: s.fastProviderId || null }, providers: funds.providers, usage: funds.usage.map(u => ({ key: u.key, title: u.title, ...(u.badge ? { plan: u.badge } : {}), bars: u.bars, lines: u.lines, ...(u.error ? { error: u.error } : {}), fetchedAt: new Date(u.fetchedAt).toISOString() })) });
        } catch (error) {
          if (signal.aborted) throw error;
          return result({ automation, providersError: error instanceof Error ? error.message : String(error) });
        }
      },
    }];
    const providerStream = input.stream(signal, usage);
    const insertedWorkIds = new Set<string>();
    const stream: StreamChatFn = async function* (client, options) {
      // Automatic remarks run with reasoning off; any reasoning a provider still
      // streams is metered but kept out of the transcript. Interactive Chat keeps its stream.
      const { reasoningEffort: _effort, ...base } = client;
      const quiet = request.wake ? dispatchLlmApi(client).requestExtraBody({ ...base, disableReasoning: true }) : undefined;
      const references = [...insertedWorkIds].map(id => repository.get<CocoWork>("work", id)).filter((work): work is CocoWork => !!work && input.context().workspaces.some(w => w.id === work.workspaceId)).map(work => ({ ...work, timeline: clipTimeline(work.timeline, 10) }));
      const prepared = references.length ? { ...options, messages: [{ role: "system" as const, content: `CoCo work references selected with inserted user prompts (context data):\n${JSON.stringify(references)}` }, ...options.messages] } : options;
      for await (const event of providerStream(request.wake ? { ...base, disableReasoning: true } : client, quiet ? { ...prepared, extraBody: { ...prepared.extraBody, ...quiet } } : prepared)) {
        if (request.wake && event.type === "reasoning_delta") continue;
        yield event;
      }
    };
    const summarize = summarizeFromStream(stream, signal);
    const legacy = !reusable ? (request.history ?? []).filter(m => m.at >= contextSince && m.status !== "streaming").slice(-200) : [];
    // Message ids are unique across all sessions; an earlier Chat session may already hold `legacy-<id>` seeds.
    const seedPrefix = `legacy-${randomUUID().slice(0, 8)}`;
    const seedMessages = legacy.map(m => ({ id:`${seedPrefix}-${m.id}`,role:m.role,createdAt:m.at,parts:[{type:"text" as const,text:m.text}] }));
    for (const message of seedMessages) before.add(message.id);
    const automatic = Boolean(request.wake || autonomous);
    // Automatic turns keep live data out of the system prefix (prompt cache): the
    // autonomous briefing / visit snapshot ride the trailing note. The visit
    // snapshot drops `conversation`: the Chat transcript is already on the wire.
    const visitNote = request.wake ? (() => {
      const { conversation: _transcript, ...wake } = request.wake;
      const liveProgress = request.existingWork.filter(w => ["executing", "recovering", "verifying"].includes(w.status)).map(w => ({ id: w.id, progress: w.sessionId ? store.getSessionSummary(w.sessionId)?.progressText : undefined }));
      return `${visitTurnNote}\n\nVisit status snapshot (data):\n${JSON.stringify({ ...wake, liveProgress })}`;
    })() : undefined;
    // Hand-over instructions ride this turn only — they must never land in the
    // transcript (that would grow every later request until it breaks the provider).
    const extraSystemPrompt = request.handoverInstruction ?? (autonomous ? undefined : request.wake ? getCocoPrompt("wake") : `${getCocoPrompt("commander")}\nCurrent coordination context (data, not a replacement user message):\n${JSON.stringify({ reference: request.reference ? { ...request.reference,timeline:clipTimeline(request.reference.timeline,10) } : undefined, planOnly: request.planOnly, planningRequests:planningRequests(), rules: ruleBriefs(repository.list<CocoRule>("rule")), projects: context.workspaces, sessions: context.sessions.slice(0,100), existingWork: request.existingWork.slice(-200).map(w => ({ id:w.id,title:w.title,objective:w.objective.slice(0,600),workspaceId:w.workspaceId,status:w.status,sessionId:w.sessionId,revision:w.revision })) })}`);
    const assertTool = (name: string, args: import("../session/types.js").JsonObject): void => {
      if (!valid()) throw new Error("CoCo access changed");
      if (request.wake) throw new Error("Visit greetings only read context and reply");
      if (autonomous && AUTONOMOUS_DENIED_TOOLS.has(name)) throw new Error(`${name} is not available in an automatic wake`);
      if (COCO_CHAT_TOOLS.includes(name)) return;
      policy.assertTool(name, args);
      const busy = busyProjectFor(name, args, input.home, input.context().workspaces.flatMap(w => w.path ? [{ id: w.id, name: w.name, path: w.path }] : []), id => store.listSessions().some(s => s.workspaceId === id && store.isTurnActive(s.id)));
      if (busy) throw new Error(busyProjectMessage(busy));
    };
    const access = registerCocoExecution({
      ...(request.wake ? { toolPredicate: () => false } : autonomous ? { toolPredicate: (name: string) => !AUTONOMOUS_DENIED_TOOLS.has(name) } : {}),
      role:"commander", persona: () => autonomous ? readCocoAutonomousPersona(input.home) : request.wake ? { ...readCocoPersona(input.home), lean: true } : readCocoPersona(input.home), compaction: () => { const s = input.settings(); return { compactTriggerRatio: s.compactTriggerRatio, iterationProtectTokenRatio: s.iterationProtectTokenRatio }; }, seedMessages, workspaceId:workspace.id, signal, canStartTurn:valid, allowWorkspace:id=>input.context().workspaces.some(w=>w.id===id), stream, summarize, ...policy, assertTool,
      ...(extraSystemPrompt ? { extraSystemPrompt } : {}),
      ...(autonomous ? { wireTrailingNote: autonomous.briefing, conversationTurnLimit: AUTONOMOUS_CHAT_TURNS } : visitNote ? { wireTrailingNote: visitNote } : {}), additionalTools:request.wake ? [] : localTools,
      beforeToolExecute:assertTool,
      onPromptInsert: prompts => {
        for (const prompt of prompts) if (prompt.cocoWorkId) {
          const work = repository.get<CocoWork>("work", prompt.cocoWorkId);
          if (!valid() || !work || !input.context().workspaces.some(w => w.id === work.workspaceId)) throw new Error("Referenced work is excluded or unavailable");
          insertedWorkIds.add(work.id);
        }
      },
      cocoShell: command => input.tools.shell({...command,signal:command.signal ? AbortSignal.any([signal,command.signal]) : signal},denied),
      cocoProjectPath: id => { if (!valid()) throw new Error("CoCo access changed"); const project = input.context().workspaces.find(w => w.id === id); if (!project?.path) throw new Error("This project is excluded or unavailable"); return project.path; },
      cocoMcpCall: (serverId,name,args,callSignal) => { if(!valid())throw new Error("CoCo access changed");return mcpManager.callTool(serverId,name,args,callSignal?AbortSignal.any([signal,callSignal]):signal); },
    });
    let text = "";
    /** A stopped / failed automatic turn that never wrote a reply leaves no reasoning or tool rows in Chat. */
    const silenceUnanswered = (): void => {
      if (!automatic || !sessionId || text.trim()) return;
      const ids = store.getSessionTail(sessionId,{turns:1})?.session.messages.filter(m=>m.role==="assistant"&&!before.has(m.id)).map(m=>m.id) ?? [];
      if (!ids.length) return;
      repository.setMeta("silentChatMessageIds", [...new Set([...repository.meta<string[]>("silentChatMessageIds", []), ...ids])].slice(-200));
    };
    // Prompt-less turns have no user row to split on; the transcript view
    // starts a new turn at the first message this turn wrote.
    const unprompted = automatic || Boolean(request.handoverInstruction);
    let turnStartMarked = false;
    const markTurnStart = (): void => {
      if (!unprompted || turnStartMarked || !sessionId) return;
      const first = store.getSessionTail(sessionId,{turns:1})?.session.messages.find(m=>m.role!=="user"&&!before.has(m.id));
      if (!first) return;
      turnStartMarked = true;
      repository.setMeta("chatTurnStartIds", [...new Set([...repository.meta<string[]>("chatTurnStartIds", []), first.id])].slice(-200));
    };
    const published = new Map<string, string>();
    const publish = (status: NonNullable<CocoMessage["status"]>): void => {
      if (!sessionId) return;
      const tail = store.getSessionTail(sessionId,{turns:1});
      const messages = tail?.session.messages.filter(m=>m.role==="assistant"&&!before.has(m.id)) ?? [];
      const parts = messages.map(m => ({ message:m, text:m.parts.flatMap(p=>p.type==="text"?[p.text]:[]).join("\n\n") })).filter(p=>p.text);
      text = parts.map(p=>p.text).join("\n\n");
      for (const part of parts) { const key = JSON.stringify([part.text,status]); if (published.get(part.message.id) !== key) { published.set(part.message.id,key); callbacks.publish(part.text,status,{id:part.message.id,at:part.message.createdAt}); } }
    };
    try {
      callbacks.publish("", "streaming");
      if (reusable) { signal.throwIfAborted(); const client = await resolveClient(input.root,workspace.path,providerId || undefined); await store.setSessionProvider(sessionId,client.providerId); }
      const started = await store.startTurn({ ...(reusable?{sessionId}:{}),workspaceId:workspace.id,providerId,userText:request.request,...((automatic || request.handoverInstruction) ? { suppressUserMessage:true } : {}),...(request.continuation ? { continuation: request.continuation } : {}),fullPermissions:true,source:"coco_chat",runMode:"agent",composerInfinite:false,cocoExecutionId:access.id });
      sessionId=started.sessionId; repository.setMeta("chatSessionId",sessionId);repository.setMeta("chatContextSince",contextSince);
      // The actual session transcript is the source of truth, including tool
      // rounds and partial assistant text. The UI projection can be rebuilt.
      await waitForTurn(store, sessionId, () => { markTurnStart(); publish("streaming"); return signal.aborted || !valid(); }, 80);
      markTurnStart();
      const status=store.getSessionTail(sessionId,{turns:1})?.session.status;
      const stopped = signal.aborted || status === "cancelled" || status === "paused";
      publish(stopped?"stopped":status==="error"?"error":"completed");
      if (stopped || status === "error") silenceUnanswered();
      if (!text.trim() && !(automatic && stopped)) callbacks.publish(stopped?"Stopped. You can continue this conversation when ready.":status==="error"?"CoCo could not finish this reply. Send a follow-up to continue in the same session.":"This turn finished without a written reply. You can continue here.", stopped?"stopped":status==="error"?"error":"completed");
    } catch(error) {
      await cancelOwnedTurn(store, sessionId, access.id);
      publish(signal.aborted?"stopped":"error");
      silenceUnanswered();
      if (!(automatic && signal.aborted)) callbacks.publish(`${text}${text?"\n\n":""}${signal.aborted?"Stopped. You can continue here.":`CoCo could not finish this reply: ${error instanceof Error?error.message:String(error)}`}`,signal.aborted?"stopped":"error");
    } finally { access.release(); flushNotices(); }
  };
  return { converse, state, status, control, notice };
}
