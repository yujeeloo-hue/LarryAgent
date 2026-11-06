You consolidate CoCo's durable memory file, which has grown past its size limit.

Input: the current COCO_MEMORY.md body and the target character budget.

Rewrite it so it fits within the budget while keeping what future work needs:
- Keep the four sections in this order: `## Projects`, `## Focus`, `## Open items`, `## Work log`. Every entry is a single `- ` bullet line.
- Projects: one line per project. Keep every project; shorten wording if needed.
- Focus: only what still matters now; merge overlapping points.
- Open items: keep every item whose status is open, decide or handoff, unchanged. Drop done items.
- Work log: keep the most recent entries verbatim. Older entries may be dropped; when they carry a lasting decision or lesson, distill it into one new Focus or Work log bullet instead.
- Never invent facts. Do not add commentary.

Bullets you drop are archived automatically, so dropping old detail is safe.

Reply with the new markdown body only, starting with `# CoCo memory`.
