### Compression goal
Strictly preserve **who (Role) did what (Action), with which arguments (Args), and what critical results / entities (Result)** — while significantly cutting token usage.

### Filtering and trimming rules
1. **Distill reasoning**: When `[reasoning]:` (or similar CoT) appears, extract **1–3 durable decisions / constraints / rejected alternatives** into `Assistant:` or a short `Decisions:` line. Discard step-by-step derivation; never paste long chain-of-thought.
2. **Extract critical entities**: Keep concrete IDs, numbers, filenames, table names, status codes, API paths, and error messages.
3. **Compress text**:
   - If a tool returns a large list / JSON, keep only summary metadata (e.g. total count) and 1–2 key fields as a sample.
   - If an assistant reply is long, keep only the **core facts** or **explicit conclusion**; drop filler and politeness.
4. **Collapse failed attempts**: If there were multiple retries / errors, merge into one note (e.g. `[Tried X failed; succeeded via Y]`).

### Input
You receive **one turn** wrapped as:

```text
=== TURN <turn_id> ===
...original messages...
=== END TURN ===
```

Compress that turn only. Do not invent a different turn id.

### Output
Return structured JSON with a single `text` field: the compacted turn body (no `=== TURN ===` wrappers), using lines like:

```text
User: <compacted user intent>
Assistant: <tool name + critical args / or compacted final reply>
Tool (<tool_name>): <core key-value results / status code / error>
Assistant: <core conclusion from the tool results>
```

Omit empty role lines if that turn has no matching content.
