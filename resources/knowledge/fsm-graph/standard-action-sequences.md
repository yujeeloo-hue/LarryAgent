---
title: Standard NodeAction sequences and catalog
category: fsm-graph
summary: "Recommended action stacks per node pattern (model round, decision, shell, data, entry, end), action prerequisites, and the registered action catalog."
keywords: [fsm_graph_action, NodeAction, model round, PrepareRole, RouteTo, Compare, RunShell, PromptInject, 动作, 节点动作]
related_tools: [fsm_graph_action, fsm_graph_node]
guide_for: [fsm_graph_action]
version: 1
updated_at: 2026-11-27
---

## Editing actions

- Start with `fsm_graph_action` `catalog`, then `describe` with `contextId` + `nodeId` + `type`: it returns the real local pins, connections, pattern guidance, `paramsSchema`, prerequisites and a minimal example.
- `add` needs `contextId`, `expectedRevision`, `nodeId`, `type`; `params` must satisfy the schema. Optional `beforeActionId` inserts before an existing action, otherwise it appends. A stable `actionId` is returned.
- `update` / `remove` / `move` address actions by `actionId`, never by array index. `update` with `params` REPLACES the whole params object. `move` without `beforeActionId` moves to the end.
- Missing visit-local prerequisites and unfinished wiring are saved as draft diagnostics; malformed parameters are rejected atomically.
- Adding or validating an action never executes it.

## Model round (pattern model_round)

```text
RoundGate → PrepareRole → PrepareTools → (DisableTools) → (PromptInject…) → BuildModelWindow → CallModel
→ RunTools → ApplyToolEffects → EmitRouteEvent → (CheckPlan) → (AwaitSubagents) → (DetectStepClaim) → RouteTo
```

- `PrepareRole` requires `roleKind`. Choose the prompt explicitly: `promptPreset` (`none` | `agent` | `analyser` | `planner` | `plan_writer` | `plan_reviewer` | `executor` | `replanner` | `subagent`) or `rolePromptInline` / `rolePromptFile` (priority inline > file > preset). `promptPlacement` = `persona` | `system` (default) | `overlay`. `modelBinding` = `sessionDefault` (default) | `agent` | `planner` | `planWriter` | `executor` | `replanner` | `subagent`, or `modelProviderId`.
- `PrepareTools`: `toolPolicy` (`none` | `subagent_general` | `subagent_explore` | `subagent_worker`), `allowTools` (exact or `*` patterns; `[]` means NO whitelist), `useOfferSet` (default true), `skillActor`, `skillWritePolicy`.
- `DisableTools` (`toolNames`, `merge`) is a runtime deny for this role; the offered `tools[]` schema stays fixed.
- `PromptInject` blocks go before `BuildModelWindow`; mount several in a row (order = block order). `source` = `note` | `routeGuide` | `plan` | `planDoc` | `pendingPlanDraft` | `phase` | `blackboard` | `skillReflectDigest`; `placement` = `overlay` (default, wire-only trailing message) | `system` (Bucket0).
- `BuildModelWindow` requires PrepareRole (and normally PrepareTools) in the SAME visit; a predecessor node's window is lost on transition.
- `CallModel` requires the window; optional `waitingMessage`, `disableReasoning`.
- `RunTools` consumes the round's tool calls; keep `ApplyToolEffects` right after it, then `EmitRouteEvent`, then `RouteTo`.
- `AwaitSubagents`, `PromptInject`, `DisableTools` and `SyncPlanStep` are conditional additions.
- Shortcut for custom graphs: `NodeActionRoleRoundBuilder` runs the whole stack in one composite.

## Decision node (pattern decision)

```text
Compare (asKey) … → RouteTo when[{expr, to}] + defaultPin
```

- `Compare` writes a boolean to `turnContext[asKey]` (required) and never routes. `source` = `blackboard` (needs `key`, `scope` turn|session) | `planOpenSteps` | `planPresent` | `planDocPresent` | `planDocApproved` | `autoSkillSummarize` | `fullPermissions` | `modelIterations` | `turnModelIterations` | `toolFailureCount` | `toolErrorCount` | `toolRecoveryCount` | `skillsReadCount` | `demoConfirm`; `type` int|float|string; `operator` `==` `!=` `>` `<` `<=` `>=`; `value`.
- `RouteTo when[]` rows combine flags with `&&`, `||` and parentheses; first match wins; `defaultPin` handles no match.

```json
{"operation": "add", "contextId": "ctx_…", "expectedRevision": 7, "nodeId": "gate", "type": "NodeActionCompare",
 "params": {"source": "turnModelIterations", "type": "int", "operator": ">", "value": 8, "asKey": "long.run"}}
```

## Shell node (pattern shell)

- `NodeActionRunShell` with exactly one of `command` / `scriptPath`; `cwd`, `timeoutMs` (default 60000) optional.
- Results are node-local `shellExitCode` / `shellStdout` / `shellStderr`. Use `onError=continue` when outgoing edges should handle failures (`halt` stops before edges).

## Data node (pattern data)

- `ReadBlackboard` (`key`, `scope` turn|session, `asKey`, `strict`) copies a value into turn context for routing; it does not show it to the model.
- `WriteBlackboard` (`key`, `mode` set|increment|multiply, `value`, `scope`). `set` requires `value`. Reserved runtime keys are rejected; workflow phase is `key=phase, scope=session`.

## Entry and end

- Entry: `NodeActionStartTurn` (no params) exactly once; then optional `Compare` + `RouteTo` for an entry branch. `NodeActionApplyControlIntent` consumes UI Approve/Discard with three required pins (`onApproved`, `onRejected`, `onDiscarded`).
- End: `NodeActionFillEmptyAssistant` + `NodeActionFinishIdle`; optional `NodeActionNotifyTaskDone`.

## Prerequisites (validated per visit)

| Action | Requires earlier in the same node | Provides |
| --- | --- | --- |
| PrepareRole | — | iterationSpec |
| PrepareTools | — | tools |
| BuildModelWindow | iterationSpec | messages |
| CallModel | messages, tools | modelRound |
| RouteTo / ApplyControlIntent / CommitStep / DetectStepClaim | — | routeTarget |
| RunShell | — | shellResult |
| EdgDispatch | — | toolCalls |

## Action catalog

- Round: `RoundGate`, `PrepareRole`, `PrepareTools`, `DisableTools`, `PromptInject`, `BuildModelWindow`, `CallModel`, `RunTools`, `ApplyToolEffects`, `EmitRouteEvent`, `RouteTo`, `RoleRoundBuilder` (composite).
- Conditions / data: `Compare`, `EmitRouteEventWhen` (typed condition that fires a named route event), `WhenToolCall` (flag when a tool call matches), `ReadBlackboard`, `WriteBlackboard`.
- Plan: `CheckPlan`, `SyncPlanStep`, `SyncPlanDoc`, `SetPlanCard`, `SetPlanApprovalPending`, `ClearPlanDraft`, `CompleteActivePlan`, `DetectStepClaim`, `VerifyStep`, `CommitStep`, `ValidateCommitStep` (composite).
- Subagents: `AwaitSubagents`.
- Entry / end: `StartTurn`, `ApplyControlIntent`, `FillEmptyAssistant`, `FinishIdle`, `NotifyTaskDone`, `SetComposerRunMode`.
- Shell / reuse lane: `RunShell`, `EdgPlanSchema`, `EdgAdmit`, `EdgDispatch`.
- All types are prefixed `NodeAction` (e.g. `NodeActionCompare`). Always `describe` before configuring.
