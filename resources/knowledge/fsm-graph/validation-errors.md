---
title: FSM authoring and validation errors
category: fsm-graph
summary: "Every error and warning code from fsm_graph_* tools and graph validation, what it means and how to fix it."
keywords: [validation, error, diagnostics, CONTEXT_CONFLICT, UNWIRED_ROUTE_PIN, ACTION_PREREQUISITE_MISSING, GRAPH_INVALID, 校验, 报错]
related_tools: [fsm_graph_context, fsm_graph_node, fsm_graph_connection, fsm_graph_action]
version: 1
updated_at: 2026-11-27
---

## Reading validation output

- `validate` returns `valid`, `errors`, `warnings` and `issues[]`. Each issue has `code`, `severity` (error | warning), `stage` (structure | actions | flow), `path`, `message`, `suggestion`, and when relevant `nodeId`, `actionId`, `edgeId`, `expected`, `actual`, `options` (e.g. the node's existing pins).
- Fix all errors before `commit`; review warnings. Validation never executes actions.

## Editing-call errors

| Code | Meaning | Fix |
| --- | --- | --- |
| `CONTEXT_CONFLICT` | `expectedRevision` is stale, or the saved draft changed | `inspect`, take the current revision, redo the edit |
| `CONTEXT_NOT_FOUND` / `INVALID_CONTEXT_ID` | Unknown or malformed contextId | `list` to find resumable contexts |
| `CONTEXT_WORKSPACE_MISMATCH` | Context belongs to another workspace | Use a context created in this workspace |
| `BUILTIN_READ_ONLY` | Tried to open a built-in graph | `create` with `template` to fork it |
| `GRAPH_NOT_FOUND` | Unknown graphId | `list` saved graphs |
| `GRAPH_INVALID` | `commit` with blocking issues | Fix the listed issues, validate, commit |
| `NODE_NOT_FOUND` / `PIN_NOT_FOUND` / `ACTION_NOT_FOUND` / `CONNECTION_NOT_FOUND` | Stale id | `inspect` for current ids |
| `DUPLICATE_NODE` / `DUPLICATE_PIN` / `DUPLICATE_ACTION_ID` / `DUPLICATE_CONNECTION` | Id already used | Choose another id |
| `PROTECTED_NODE` | Removing the entry or terminal node | Pick new ones with `set_meta` first |
| `CONNECTION_CONFLICT` | New edge clashes with an `EdgeAlways` or a pin's existing connection | Disconnect / update the existing edge explicitly |
| `NOTHING_TO_UNDO` | No earlier edit | — |
| `MISSING_ARGUMENT` / `INVALID_ARGUMENT` / `UNKNOWN_OPERATION` | Bad call shape | Check the operation's required fields |
| `UNKNOWN_TYPE` / `UNKNOWN_PATTERN` / `UNKNOWN_TEMPLATE` | Unknown action/edge type, pattern or template | Use `catalog` names; templates: react, react_v2, ask, plan_execute, subagent |
| `INVALID_ACTION_PARAMS` / `INVALID_EDGE_PARAMS` | Params fail the registered schema (e.g. `unknown param "type"` on EdgeWhen) | `describe` the type and use its exact schema |

## Structure errors

| Code | Meaning | Fix |
| --- | --- | --- |
| `INVALID_NODE_ID` | Empty or duplicate node id | Unique, non-empty ids |
| `INVALID_PIN` | Empty or duplicate pin name in a node | Rename/remove the duplicate |
| `MISSING_ENTRY` / `MISSING_TERMINAL` | entry/terminal node id does not exist | `set_meta` to an existing node |
| `NON_TERMINAL_NO_OUTGOING` | A non-terminal node has no exit (and no selfLoop) | Connect it to its next stage |
| `EDGE_ALWAYS_NOT_ALONE` | EdgeAlways plus other outgoing edges | Remove EdgeAlways before adding branches |
| `DANGLING_EDGE` | Edge endpoint does not exist | Create the node or reconnect |
| `DUPLICATE_EDGE_ID` | Repeated connection id | New connectionId |
| `UNKNOWN_EDGE` / `UNKNOWN_ACTION` | Unregistered type | Use catalog names |
| `PIN_EDGE_MISMATCH` | A routeTarget edge `equals` a pin the node does not have | Add the pin or fix the edge |
| `DUPLICATE_PIN_EDGE` | Two edges own the same pin | One edge per pin |
| `RETIRED_EDGE_KEY` | Edge reads a retired turnKey | Use `routeTarget` + pin |
| `ROLE_PROMPT_FILE_UNREADABLE` | `rolePromptFile` cannot be read | Fix the path or use `rolePromptInline` |
| `EMPTY_NODES` / `INVALID_VERSION` | Config has no nodes / unsupported version | Rebuild with the editing tools |
| `INVALID_GRAPH` | Other load/validation failure | Read `message` |

## Action errors

| Code | Meaning | Fix |
| --- | --- | --- |
| `ACTION_PREREQUISITE_MISSING` | An action needs visit-local data no earlier action in the same node provides (nodeContext resets every visit) | `iterationSpec` → add PrepareRole earlier; `tools` → PrepareTools before BuildModelWindow; `messages` → BuildModelWindow after PrepareRole/PrepareTools |
| `EMPTY_ROUTE_MAPPING` | RouteTo has no usable `routes` or `when` rows (would halt) | Add `routes [{event,to}]` or `when [{expr,to}]` naming local pins |
| `UNKNOWN_PIN` | Action references a pin the node does not have | Create the pin (`add_pin` or `connect` with `pin`) or choose an existing one (`options`) |

## Flow errors

| Code | Meaning | Fix |
| --- | --- | --- |
| `MISSING_ROUTE_PRODUCER` | Outgoing pin connections read `routeTarget`, but no action in the node selects a pin | Add RouteTo (or ApplyControlIntent / CommitStep / DetectStepClaim), or use another predicate |
| `UNWIRED_ROUTE_PIN` | A referenced pin has no connection and the node cannot self-loop | Connect the pin, or set `selfLoop=true` for intentional re-entry |
| `AMBIGUOUS_CONNECTION` | Two outgoing edges with identical predicates | Remove the duplicate / make conditions exclusive |
| `TERMINAL_UNREACHABLE` | No structural path from entry to terminal | Add a completion path |

## Warnings

| Code | Meaning |
| --- | --- |
| `TOOLS_NOT_PREPARED` | BuildModelWindow without PrepareTools before it; tool set may be empty or turn-level |
| `EMPTY_NODE` | Non-terminal node with no actions only passes control |
| `UNREACHABLE_NODE` | No path from entry reaches this node |
