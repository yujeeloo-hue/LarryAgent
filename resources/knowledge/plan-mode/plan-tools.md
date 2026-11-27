---
title: Plan tools reference
category: plan-mode
summary: "Exact arguments, serial-step rules, rejections and examples for create_plan, update_plan, complete_plan and write_plan_doc."
keywords: [create_plan, update_plan, complete_plan, write_plan_doc, adopt_plan_doc, checklist, steps, in_progress, 计划, 步骤]
related_tools: [create_plan, update_plan, complete_plan, write_plan_doc, adopt_plan_doc, report_step_blocked]
guide_for: [create_plan, update_plan, complete_plan, write_plan_doc]
version: 1
updated_at: 2026-11-27
---

## When to plan

- Use a checklist for genuinely multi-step work (several files, phases or verifications). Skip it for one-shot edits.
- In free ReAct: `create_plan` → `update_plan` per step → `complete_plan`.
- In plan mode the planner creates the checklist after Approve; see read_knowledge("plan-mode/plan-execute-flow").

## create_plan

```json
{"title": "Add export button", "steps": ["Locate the toolbar view", "Add the button and handler", "Write tests", "Run lint and tests"]}
```

- `steps`: 2–12 plain strings in execution order. They become `s1`, `s2`, … and each depends on the previous one (serial chain).
- Object steps or explicit `dependsOn` are rejected (returnCode 5).
- Replaces any active plan. `title` defaults to `Plan`.
- In plan mode the planner / executor require a plan document first (otherwise returnCode 5). The Direct agent keeps a doc-free checklist.
- The result carries a `plan_json:` line that drives the Plan card.

## update_plan

```json
{"steps": [{"id": "s2", "status": "completed"}]}
```

- `steps[]` items: `id` (omit to append a new step at the end), `title` (rename or new title), `status` = `pending` | `in_progress` | `completed` | `cancelled`. Optional top-level `title` renames the plan.
- One call may complete the current `in_progress` step, or a contiguous run of unfinished steps starting at it; the next ready step starts automatically.
- Rejected with returnCode 5: skipping a step, completing a step while a different one is `in_progress`, completing a cancelled step.
- A step is blocked while any predecessor is not `completed` (`cancelled` does not satisfy a dependency).
- Status changes are claims; in plan mode the validator verifies and commits them.

## complete_plan

```json
{"status": "completed", "summary": "Export button shipped with tests."}
```

- `status`: `completed` | `cancelled`. Remaining unfinished steps become `cancelled`. Also clears the plan document binding and phase.
- In plan mode the validator closes the plan when the last step commits; do not call it again.

## write_plan_doc

```json
{"title": "Export button", "summary": "Add a toolbar export action with tests.", "content": "# Export button\n\n## Goal\n…\n\n## Approach\n…\n\n## Acceptance\n…"}
```

- Writes only under `{workspace}/docs/plans/{yyyyMMdd}-{slug}.md` (slug from `title`). Whole-document write: send the complete body each time.
- `summary` ≤ 400 chars (shown to the executor); `content` aim ≤ 8000 chars (recommended).
- Session stores only `planDoc: { path, summary, updatedAt }`; details are read with `read_file`.
- Subagents cannot call it.

## adopt_plan_doc

- `{ path, summary? }` — adopt an existing document under `{workspace}/docs/plans/` without rewriting. Never claims user approval.

## report_step_blocked

- `{ step_id, error, observed? }` — the current step cannot proceed; routes to the replanner.

## Common mistakes

- Sending step objects to `create_plan`.
- Marking a later step done while the current one is still open — complete in order.
- Calling `complete_plan` instead of finishing the last step in plan mode.
- Forgetting that `write_plan_doc` overwrites the whole doc.
