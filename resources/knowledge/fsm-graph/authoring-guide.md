---
title: FSM graph authoring guide
category: fsm-graph
summary: "Design rules and the step-by-step workflow for building, validating and committing custom graphs with the fsm_graph_* tools."
keywords: [fsm_graph_context, fsm_graph_node, authoring, draft, commit, validate, contextId, expectedRevision, 搭建, 状态机, 图]
related_tools: [fsm_graph_context, fsm_graph_node, fsm_graph_connection, fsm_graph_action]
guide_for: [fsm_graph_context, fsm_graph_node]
version: 1
updated_at: 2026-11-27
---

## Node boundary

- Create a node for an independently entered stage, role, decision, deterministic operation or retry boundary.
- Keep actions that share visit-local messages, tools and results in the same node.

## Scopes

- **graphContext** — persistent editing draft. Never supplies runtime data.
- **node** — fresh on EVERY node visit, including implicit self-loops. Prepared role, tools, messages, tool calls and shell results are visit-local.
- **turn** — shared across node transitions within one turn. `Compare` writes its `asKey` flags here.
- **session** — persisted session blackboard across turns. `ReadBlackboard` materializes values into turn context; `PromptInject` exposes values to the model. `EdgeWhen source=session` reads the runtime session view, not arbitrary blackboard keys.

## Execution rules

- Actions run in array order. A halt stops remaining actions and prevents edge evaluation. Terminal-node actions run before the graph finishes.
- All outgoing edge predicates are evaluated: exactly one must match. Edge order is NOT priority. `EdgeAlways` must be the only outgoing edge.
- With `selfLoop=true`, ZERO matching edges re-enters this node with fresh node context. Multiple matches still fail. An intentionally unwired stay pin is valid for this pattern.
- Routing chain: event / Compare flag → `RouteTo` → local pin → connection → destination node. Pin names and node ids are separate identifiers.
- `RouteTo` explicit events take precedence over `when` rows, then stay/leave fallback. Within `when[]`, the first matching expression wins.
- `roleKind` is identity only. Configure prompt, model and tool policy explicitly. An empty `allowTools` list does not restrict tools.
- Validation never executes actions. Static validity does not prove all model-driven branches; inspect warnings and use scripted scenarios for behavioral checks.

## Workflow

1. `fsm_graph_context` `guide` (this doc) — once per task.
2. `fsm_graph_context` `list` — saved graph ids and resumable contextIds. Resume an existing context instead of starting over.
3. `create` (new graph; optional `template` = `react` | `react_v2` | `ask` | `plan_execute` | `subagent` to fork a built-in) or `open` (`graphId` of a saved custom graph). Built-in graphs cannot be opened for editing (`BUILTIN_READ_ONLY`) — fork them with `create` + `template`.
4. `fsm_graph_node` `add` — create EMPTY nodes first (optional `pattern`: `entry` | `model_round` | `decision` | `shell` | `data` | `end` | `custom` returns design guidance; it never inserts actions).
5. `fsm_graph_connection` `connect` — wire nodes. With `pin` for branches; plain for a single unconditional exit.
6. `fsm_graph_action` `catalog` → `describe` (with `contextId` + `nodeId` for real pins and prerequisites) → `add` actions node by node.
7. `fsm_graph_context` `validate` — fix every error, review warnings.
8. `fsm_graph_context` `commit`.

```json
{"operation": "create", "name": "Review loop", "template": "react_v2"}
```

```json
{"operation": "add", "contextId": "ctx_…", "expectedRevision": 3, "nodeId": "reviewer", "pattern": "model_round"}
```

## contextId and expectedRevision

- Every call that touches a draft names its `contextId` explicitly. It is the persistent editing context, not runtime turn or node context.
- Every mutation, `commit` and `discard` needs `expectedRevision` = the latest revision returned to you. Each successful mutation advances the revision.
- On `CONTEXT_CONFLICT` do not guess: `inspect` the context, re-read the revision and the current state, then redo the edit.
- `inspect` returns summaries and stable ids; `full=true` adds the whole draft config (use sparingly).

## Drafts

- Incomplete drafts autosave and stay editable across turns. They never run and never appear in the Composer.
- An existing saved graph keeps running its last valid saved version while you edit a draft of it.
- `undo` restores one edit and advances the revision (`NOTHING_TO_UNDO` when there is none).
- `discard` deletes only the draft. `delete_graph` deletes a saved graph.
- `set_meta`: `name`, `description` (empty string clears), `entryNodeId`, `terminalNodeId`.

## Commit and enable

- `commit` requires a statically valid draft (`GRAPH_INVALID` lists blocking issues) and checks that the saved graph did not change underneath you.
- Newly created graphs stay DISABLED after commit; only the user enables them after full validation. There is no enable operation and no whole-config save.

## Node operations

- `add` needs `contextId`, `expectedRevision`, `nodeId`; creates an empty node and returns guidance.
- `inspect` (`contextId`, `nodeId`) returns pattern guidance, pins, connections and stable action ids.
- `update` changes `name` / `selfLoop` only. `pattern` on add/update only changes guidance.
- `remove` rejects entry/terminal nodes (`PROTECTED_NODE`) and reports incident connections removed.
- `add_pin` / `remove_pin` take `pin`. Removing a referenced pin leaves a repairable draft with diagnostics.
- `selfLoop=true` permits zero matching edges to re-enter the node; see read_knowledge("fsm-graph/concepts").

## Design checklist

- One responsibility per node; a model round's PrepareRole → PrepareTools → BuildModelWindow → CallModel and its tool-result consumers stay in one visit.
- Every non-terminal node has an exit; the terminal node is reachable from entry.
- Each `RouteTo` target pin is connected (or intentionally unwired on a selfLoop node).
- Decisions use `Compare` → `RouteTo when[]`, never edge order.
- Cross-node data goes through turn/session blackboard explicitly.
- Action sequences: read_knowledge("fsm-graph/standard-action-sequences"). Errors: read_knowledge("fsm-graph/validation-errors").
