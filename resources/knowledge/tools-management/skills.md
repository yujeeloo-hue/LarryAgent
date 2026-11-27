---
title: Writing and maintaining skills
category: tools-management
summary: "Skill package format, project scope, write tools (create / update / patch / merge / deprecate), history and write policy, and how to write a skill that gets reused."
keywords: [skill, create_skill, update_skill, patch_skill, merge_skills, deprecate_skill, SKILL.md, playbook, 技能]
related_tools: [create_skill, update_skill, patch_skill, merge_skills, deprecate_skill, write_skill_file, install_skill, delete_skill, read_skill, search_skills]
guide_for: [create_skill, update_skill, patch_skill, merge_skills, deprecate_skill]
version: 1
updated_at: 2026-11-27
---

## Skills vs knowledge

- A skill is the user's playbook for a recurring workflow (build / release, conversions, domain APIs, house conventions). Agents follow it step by step.
- The knowledge base holds reference rules for the app's own complex capabilities. Do not put workflows there or reference manuals into skills.

## Package format

- Directory `skills/<name>/` with required `SKILL.md`: YAML frontmatter `name`, `description`, optional `project`, then the markdown body. Optional supporting files (scripts, docs, assets) next to it.
- `name`: unique slug (lowercase, digits, hyphens; ≤ 64). `description` ≤ 1024 — it is what the `[Installed skills]` list and `search_skills` match, so lead with the trigger ("Use when …").
- `project`: owning workspace folder slug; omit to keep the current project; `"*"` makes it universal.

## Write tools (all permission level 1 — need Bypass permissions)

| Tool | Use |
| --- | --- |
| `create_skill` | `{ name, description, body, enabled?, project?, files?: [{path, content}], reason? }` |
| `update_skill` | By `id` / `name`: `new_name`, `description`, `body` (replaces), `enabled`, `files`, `remove_files`, `project`, `reason` |
| `patch_skill` | `{ id?|name?, edits?: [{old_string, new_string}] (≤16, each unique; whitespace-insensitive), description?, reason }` — preferred for small fixes |
| `merge_skills` | `{ source_ids (≥2), target: { id? or name?, description, body, files? }, reason }` — target keeps one source or creates a new skill; other sources are deprecated with `supersededBy` |
| `deprecate_skill` | `{ id?|name?, superseded_by?, reason }` — disables, never deletes |
| `write_skill_file` | `{ id?|name?, path, content, reason? }` — supporting file (not SKILL.md) |
| `install_skill` | `{ path (.zip), overwrite?, enabled?, name? }` |
| `delete_skill` | `{ id?|name? }` — permanent; prefer deprecate |

- `reason`: one sentence citing the concrete fact (failure, correction, overlap). It is stored in the skill's version history.

## History and write policy

- Every content change snapshots the previous version first (kept per skill); the user can diff and restore on the Skills screen.
- Metadata: `origin` (`user`, `installed`, `agent`, `reflector`, `coco`), `status` (`active` | `deprecated`), `supersededBy`, `revision`.
- Under the reflector's `auto_owned_only` policy, edits to skills not owned by `reflector` / `coco` become suggestions the user accepts or rejects; `create_skill` is always direct and `delete_skill` is refused.
- First reads per turn are recorded in a usage ledger (outcome, errors, recoveries) that feeds Skills stats and curation.

## Before writing

1. `search_skills` (and `include_inactive: true`) to avoid duplicates; `read_skill` close matches.
2. Prefer `patch_skill` on an existing skill over creating a near-duplicate; merge overlapping skills.

## Writing a skill that gets reused

- Description: when to use it, in words a future request would contain.
- Body: prerequisites, exact commands / paths, ordered steps, verification, known pitfalls. Imperative, specific, short.
- Put long scripts or reference tables in supporting files and point to them from SKILL.md.
- Never store secrets; reference where the user keeps them.
