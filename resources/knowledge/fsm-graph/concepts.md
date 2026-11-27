---
title: FSM graph concepts
category: fsm-graph
summary: "Mental model of custom workflow graphs: nodes, NodeActions, pins, edges, data scopes, self-loops, entry and terminal nodes."
keywords: [fsm, graph, node, pin, edge, nodeContext, blackboard, selfLoop, 状态机, 节点, 工作流]
related_tools: [fsm_graph_context, fsm_graph_node, fsm_graph_connection, fsm_graph_action]
version: 1
updated_at: 2026-11-27
---

## What a graph is

- A graph drives ONE user turn from start to finish. `workflow.run` enters the entry node and keeps moving between nodes (possibly through many model and tool rounds) until the terminal node finishes.
- Built-in graphs (`react`, `react_v2`, `ask`, `plan_execute`, `subagent`) are read-only. Custom graphs are created as drafts with the `fsm_graph_*` tools, optionally forked from a built-in template.
- A graph has `nodes[]`, `edges[]`, an `entryNodeId` and a `terminalNodeId` (defaults to `end`).

## Nodes

- A node is an independently entered processing stage: a role (agent, planner, reviewer…), a decision, a deterministic operation (shell, data) or a retry boundary.
- A node holds an ordered list of NodeActions. Actions run in array order on every visit.
- A halting action stops the remaining actions of that visit and prevents edge evaluation.
- Actions on the terminal node run before the graph completes.
- Keep actions that share visit-local data (prepared role, tools, model window, tool calls, shell results) in the SAME node. Split into separate nodes only at real boundaries.

## NodeActions

- Each action is roughly one Host capability (`PrepareRole`, `CallModel`, `RunTools`, `Compare`, `RunShell`…), identified by its registered type, e.g. `NodeActionCallModel`.
- Parameters are validated against the action's registered schema plus a custom validator. Malformed parameters are rejected atomically when you add or update an action.
- Composite actions (`NodeActionRoleRoundBuilder`, `NodeActionValidateCommitStep`) run their children in order within the SAME visit; children are validated recursively.
- `roleKind` on `PrepareRole` is an identity label only. Prompt, model binding and tool policy are separate, explicit settings.

## Data scopes

| Scope | Lifetime | Typical use |
| --- | --- | --- |
| graph context | Persistent editing draft (contextId) | Never supplies runtime data |
| node (`nodeContext`) | Fresh on EVERY node visit, including implicit self-loops | Prepared role, tools, messages, tool calls, shell results, `routeTarget` |
| turn (`turnContext`) | Shared across node transitions within one turn | `Compare` writes its `asKey` flags here; `ReadBlackboard` materializes values here |
| session | Persisted session blackboard across turns | Workflow `phase`; written with `WriteBlackboard scope=session` |

- Reading state and showing it to the model are different operations: `ReadBlackboard` only copies data into turn context; use `PromptInject source=blackboard` to make it visible to the model.
- `EdgeWhen source=session` reads the runtime session view (for example `phase`), not arbitrary blackboard keys.
- Runtime-reserved keys cannot be written by `WriteBlackboard`.

## Pins and routing

- A pin is a named local exit of a node. Pin names are separate from destination node ids.
- Routing chain: route event or Compare flag → `NodeActionRouteTo` writes `nodeContext.routeTarget` = a local pin → a connection (`EdgeWhen source=node turnKey=routeTarget equals=<pin>`) → destination node.
- Details: read_knowledge("fsm-graph/routing-and-edges").

## Edges

- `EdgeAlways` — unconditional; must be the ONLY outgoing edge of its node.
- `EdgeWhen` — conditional on `turnKey`/`equals` from `turn`, `node` or `session`.
- All outgoing edges are evaluated; exactly one must match. Edge order is NOT priority.

## Self-loops

- `selfLoop=true` on a node means: when ZERO outgoing edges match, re-enter this node with a fresh node context. Multiple matches still fail.
- An intentionally unwired "stay" pin is valid on a selfLoop node — it is how a role node keeps working round after round.
- Mount `NodeActionRoundGate` first on any self-looping node so Stop, turn budgets and queued steer messages are honored.
- `selfLoop` must express intentional repetition, not hide an unfinished graph.

## Entry and terminal

- Entry node: `NodeActionStartTurn` exactly once (opens the Host turn), then optional `Compare` + `RouteTo when[]` for phase/resume routing.
- Terminal node: usually `NodeActionFillEmptyAssistant` + `NodeActionFinishIdle`; `NodeActionNotifyTaskDone` is optional.
- Entry and terminal nodes cannot be removed until `set_meta` picks other nodes.

## What validation does and does not prove

- Validation checks static structure, registered parameter schemas, recursive action prerequisites and local pin wiring. It never executes actions.
- Static validity does not prove that every model-driven branch behaves well. Inspect warnings and reason about each branch.
