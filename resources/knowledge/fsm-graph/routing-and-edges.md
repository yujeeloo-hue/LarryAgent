---
title: FSM routing, pins and edges
category: fsm-graph
summary: "How RouteTo, local pins and EdgeAlways / EdgeWhen connections route between nodes, with the exact accepted edge parameters."
keywords: [fsm_graph_connection, pin, edge, EdgeWhen, EdgeAlways, RouteTo, routeTarget, selfLoop, 路由, 连线]
related_tools: [fsm_graph_connection, fsm_graph_action]
guide_for: [fsm_graph_connection]
version: 1
updated_at: 2026-11-27
---

## Routing chain

```text
route event / Compare flag → NodeActionRouteTo → nodeContext.routeTarget = <local pin> → connection → destination node
```

- Pins are local to their node; pin names are NOT destination node ids.
- A pin owns at most one route connection.

## RouteTo

- Shape 1 — `routes: [{event, to}]` binds route events to pins: `stay`, `leave`, `fsm_route` values and tool route events. Fallback: `stay` when tools ran or a subagent batch was injected, otherwise `leave`.
- Shape 2 — `when: [{expr, to}]` boolean rows over Compare `asKey` flags (`&&`, `||`, parentheses); first match wins. Optional `defaultPin` and `onlyIfRouteTargetUnset` (keeps a pin already chosen earlier, e.g. by Approve).
- Precedence: explicit route event → `when[]` → event fallback.
- `to` and `defaultPin` name LOCAL pins. `describe` the action with `contextId` + `nodeId` to see the actual pins.

```json
{"routes": [{"event": "stay", "to": "again"}, {"event": "leave", "to": "done"}]}
```

## Connecting nodes

- `fsm_graph_connection` `connect` needs `contextId`, `expectedRevision`, `from`, `to`.
- Omit `pin` / `type` / `params` → a single unconditional `EdgeAlways`.
- With `pin` → the tool creates that source pin if missing and adds `EdgeWhen {source: "node", turnKey: "routeTarget", equals: <pin>}`. Configure a separate `RouteTo` to select the pin. `pin` cannot be combined with `type` / `params`.
- Explicit predicates: `describe` the edge type first, then pass `type` + `params`.
- `update` needs `connectionId` plus the full new `from` / `to` and specification; `disconnect` needs `connectionId`.
- Conflicts never overwrite: an existing `EdgeAlways` or a pin that already owns a connection gives `CONNECTION_CONFLICT` — disconnect or update explicitly.

```json
{"operation": "connect", "contextId": "ctx_…", "expectedRevision": 5, "from": "reviewer", "to": "writer", "pin": "rewrite"}
```

## EdgeAlways

- No params. Must be the ONLY outgoing edge of its node (`EDGE_ALWAYS_NOT_ALONE`).

## EdgeWhen parameters (exactly what validates)

| Param | Meaning |
| --- | --- |
| `turnKey` (required) | Key to read |
| `equals` | Value compared with strict equality |
| `source` | `turn` (default, turnContext) \| `node` (nodeContext, e.g. `routeTarget`, `shellExitCode`) \| `session` (Host session fields such as `phase`) |
| `unlessNodeKey` | Skip when that nodeContext key is a non-empty string (e.g. `routeTarget` already set) |
| `requireIncompletePlan` | Also require an active plan with open steps |

- The registered schema rejects any other key (`unknown param`). Although the runtime predicate understands `type` / `operator` / `value`, the validator currently rejects them on connections — do NOT pass them. For numeric or ordered comparisons, put `Compare` (or `EmitRouteEventWhen`) + `RouteTo` in the node and connect pins instead.
- Branching on a shell result: compare equality, e.g. `{"source": "node", "turnKey": "shellExitCode", "equals": 0}` plus a mutually exclusive second edge, or use Compare/RouteTo.
- `turnKey` values retired by the pin model are rejected (`RETIRED_EDGE_KEY`): use `routeTarget` + pin.

## Exactly one match

- All outgoing edges are evaluated on leaving a node; exactly ONE must match. Edge order is not priority.
- Two edges with the same predicate are `AMBIGUOUS_CONNECTION`.
- Zero matches is an error unless the node has `selfLoop=true`, in which case it re-enters itself with fresh nodeContext.

## Stay pins and self-loops

- On a `selfLoop` node, a `RouteTo` pin may be intentionally left unwired (typically `again` / `stay`): selecting it matches no edge, so the node re-enters.
- On a node without `selfLoop`, every referenced pin must be connected (`UNWIRED_ROUTE_PIN`).
- An implicit self-loop alone cannot finish the graph: the terminal node must still be reachable (`TERMINAL_UNREACHABLE`).
