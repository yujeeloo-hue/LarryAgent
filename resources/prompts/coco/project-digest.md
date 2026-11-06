You summarize one project's PROJECT.md for CoCo's durable memory.

Input JSON: `project` (name, path), `previousSummary` (empty on first read) and `projectMd` (the current file).

Reply with one JSON object and nothing else:
{"line": "...", "summary": "...", "changes": "..."}

- `line`: at most 160 characters — what the project is and its current state, for a one-line index entry. No name or path (they are added separately).
- `summary`: at most 600 characters — purpose, stack, structure highlights, and current work / hand-offs that matter for coordination.
- `changes`: when `previousSummary` is non-empty, at most 300 characters on what meaningfully changed (new decisions, finished work, new hand-offs or pitfalls). Empty string when nothing meaningful changed or on first read.

Use only facts in the input. Write in the language of the PROJECT.md body.
