---
title: Plan mode workflow (plan_execute)
category: plan-mode
summary: "How a plan-mode task moves through gathering, plan doc writing, review, user Approve, serial execution with validation, replanning and closure."
keywords: [plan mode, plan_execute, fsm_route, analyser, plan_writer, reviewer, executor, approve, 计划模式, 审批]
related_tools: [fsm_route, write_plan_doc, adopt_plan_doc, create_plan, update_plan, complete_plan, report_step_blocked, ask_user]
version: 1
updated_at: 2026-11-27
---

## Overview

Plan mode runs a fixed graph of roles inside each turn. Each role gets its own instructions as a system message after AGENT (e.g. `[ANALYSER]`, `[PLAN_WRITER]`); the FSM route guide (`## FSM routes`) and the current `Phase: …` follow it. A trailing `[Role overlay]` user message carries live plan fields — it is not from the user. Never describe roles, routes or phases to the user.

```text
analyser ──gather──▶ analyser (stay)
         ──plan────▶ plan_writer ─▶ plan_reviewer ──ready──▶ idle + Approve / Discard bar
         ──direct──▶ agent (dead end)            └─rewrite─▶ plan_writer
Approve ─▶ planner (create_plan) ─▶ executor ⇄ execution_validator ─▶ (reflect) ─▶ end
blocked step ─▶ replanner ─▶ executor
```

## Gathering (analyser)

- Collect context only (read / search). Writes, shell, plan tools and skill/memory/MCP writes are denied in this role.
- End every round with `fsm_route`: `gather` (keep collecting), `plan` (enough context — go write the plan), or `direct` (small task, no plan needed).
- `direct` goes to the Direct agent, which is a dead end for this task: it cannot reopen gathering or the writer. It may keep its own doc-free checklist (`create_plan` / `update_plan` / `complete_plan`).

## Writing and review

- `plan_writer` writes the plan document with `write_plan_doc` (`{workspace}/docs/plans/{yyyyMMdd}-{slug}.md`), then control passes to the reviewer. `adopt_plan_doc` reuses an existing doc under `docs/plans/` instead of rewriting.
- `plan_reviewer` fills gaps itself (`ask_user`, reads, `write_plan_doc`) and never calls `create_plan` or sends work back to the analyser.
  - `fsm_route ready` → the turn idles and the user sees **Approve** / **Discard**.
  - `fsm_route rewrite` → back to `plan_writer`.
- `Session.plan` stays empty during review; the plan card appears only after the planner's `create_plan`.

## Approve and Discard

- Approve starts a new control turn: phase becomes `planning` and the **planner** calls `create_plan` (the plan document is required), then the executor starts.
- Discard clears the plan and deletes the plan document; the turn ends.

## Execution

- The executor works the checklist serially: exactly one step `in_progress`.
- Claim progress with `update_plan`: complete the current step, or a contiguous run starting at it. The next ready step starts automatically.
- Every claim goes through the validator: it checks each claimed step's predecessors are completed, then commits. Failure reverts the failed step to `in_progress` (later claimed steps back to `pending`) and returns to the executor.
- When the last step commits, the plan closes itself (status `completed`, plan doc binding and phase cleared). Do not call `complete_plan` after the validator closed it.
- A blocked step: `report_step_blocked` (`step_id`, `error`, optional `observed`) → replanner revises the plan with plan tools → executor resumes.
- Plan step progress resets the turn budgets (model iterations and tokens) so each step gets a fresh budget.

## Resume across turns

- The session blackboard key `phase` (`gathering`, `drafting`, `review`, `planning`, `executing`) decides where the next turn resumes. `executing` resumes the executor only while a step is still open.
- A plan left `active` with open steps means the next turn continues executing it.

## Rules of thumb

- Keep the plan document as the source of detail; the executor overlay shows only its path and summary — `read_file` it when you need details.
- Tool shapes and rejection rules: read_knowledge("plan-mode/plan-tools").
