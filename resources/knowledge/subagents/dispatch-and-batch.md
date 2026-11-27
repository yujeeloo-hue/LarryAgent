---
title: Dispatching subagents and joining batches
category: subagents
summary: "When and how to run parallel child agents: roles, batch_id joins, queue and caps, awaiting results, the JSON reply contract and prompt-writing tips."
keywords: [dispatch_subagent, await_subagent, subagent_batch_result, batch_id, parallel, explore, worker, 子代理, 并行]
related_tools: [dispatch_subagent, await_subagent, subagent_batch_result, get_subagent_status, list_subagents, stop_subagent]
guide_for: [dispatch_subagent, await_subagent]
version: 1
updated_at: 2026-11-27
---

## When to dispatch

- Independent pieces of work that can run in parallel (survey several modules, compare options, run separate investigations).
- Do NOT dispatch for lookups one or two searches can answer, or for tightly sequential work where each step needs the previous result.
- Children cannot ask the user, plan, dispatch further children, or edit skills / MCP / memory / knowledge.

## dispatch_subagent

```json
{"prompt": "Survey src/llm/adapters and list every place that sets request timeouts. Report file, line, value.", "batch_id": "timeouts", "name": "adapters", "role": "explore", "priority": 60}
```

- `prompt` (required) — complete, self-contained instructions: the child sees none of your conversation. State the goal, scope (paths), what to return and the output format.
- `batch_id` (required) — join group. Dispatch every member of a group in the same model iteration.
- `name` — short nickname for UI / logs. `id` is still what await / stop / status use.
- `role` — `general` (default), `explore` (read-only: no writes / shell; MCP via the bridge), `worker`.
- `priority` — 0–100 (default 50); higher starts sooner when queued.
- Returns immediately with `{ id, name, batchId, priority, status: "queued" | "running" }`.

## Queue and caps

- At most 4 children run concurrently; further dispatches wait in a queue ordered by priority, then creation time. No preemption.
- At most 8 children per parent turn. Nesting depth 1.
- Child model iterations: `min(parent, 16)` (Infinite mode lifts the cap).
- Children inherit the parent's Bypass permissions state.

## Getting results

- Default: do nothing special. After your tool iteration seals open batches and all members finish, the results arrive automatically as a `subagent_batch_result` tool result. If you reply without tool calls while a batch is still running, the turn waits for it, injects the results and runs another model iteration.
- `subagent_batch_result { batch_id, timeout_ms? }` waits for / re-fetches a batch explicitly.
- `await_subagent { ids, timeout_ms? }` for an early or partial join. Default and minimum timeout 240000 ms; on timeout, still-running awaited children are aborted. Awaiting a whole batch marks it delivered (no double injection).
- A sealed or delivered `batch_id` cannot be reused in the same turn.
- `get_subagent_status { ids? }` (non-blocking), `list_subagents { include_finished? }`, `stop_subagent { ids }`.
- Parent Stop / turn end cancels remaining children, including queued ones.

## The child's reply contract

Each child's final message is one JSON object:

```json
{"result": "dense findings", "attachment": [{"path": "/abs/file.ts", "note": "optional"}], "table": [{"title": "optional", "headers": ["col"], "rows": [["cell"]]}]}
```

- Caps: `result` ≤ 4000 chars; `attachment` ≤ 8 items (note ≤ 200), ≤ 4000 chars of JSON; `table` ≤ 4 tables, ≤ 12 columns, ≤ 40 rows, cell ≤ 200, title ≤ 120, ≤ 8000 chars of JSON.
- Ask children for exactly the data you need in that shape (e.g. a table of file / line / value) so the merge step is mechanical.

## Writing good child prompts

- One clear objective per child; non-overlapping scopes across a batch.
- Name absolute paths, symbols and constraints; say whether edits are allowed (`worker`) or forbidden (`explore`).
- Say what "done" means and how to report uncertainty.
- Verify important findings yourself before acting on them.
