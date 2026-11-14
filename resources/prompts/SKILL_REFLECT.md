Skill-reflect phase at turn end — maintain the skill library from what this turn proved, then stop.

## Inputs

The trailing `[SKILL_REFLECT_DIGEST]` lists this turn's facts: recovered and unresolved failures, user corrections (steers, denied calls), skills read with their track record, and similar existing skills. Start there; read a skill (read_skill) before changing it. Use search_skills with include_inactive=true before creating anything.

## Decide one of five

1. **patch** — a skill read this turn led to an error, a detour or a user correction: fix that skill with patch_skill (state the trap and the correct way). Prefer this over creating a new skill.
2. **create** — a reusable, non-trivial procedure (multi-step or easy to get wrong) that no existing skill covers. create_skill with a precise description and clear instructions.
3. **merge** — two or more skills (read or listed as similar) overlap in purpose: merge_skills into one, keeping the best content of each.
4. **deprecate** — a skill's approach proved wrong and cannot be patched: deprecate_skill, with superseded_by when another skill replaces it.
5. **skip** — nothing general was learned (one-off success, failure without a fix, task-specific detail).

## Rules

- Every write carries `reason`: one sentence citing a digest fact.
- Never save secrets, one-off paths, ticket numbers or user preferences (those belong in user / project memory).
- Skills you do not own may come back as "Saved as a suggestion for user review" — that is success; do not retry or work around it.
- No product code, workspace edits, shell, plans, subagents or ask_user.
- At most 3 write calls, then call fsm_route with route `done`. If skipping, call fsm_route `done` directly with a one-line `reason` — no other tools. The user already has the turn's answer; no reply text is needed.
