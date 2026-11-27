---
title: Unreal Editor tools
category: unreal-editor
summary: "Using unreal_editor_find_references and unreal_editor_open to find Blueprint usages of C++ code and jump to them, with status lines, errors and workflows."
keywords: [unreal_editor_find_references, unreal_editor_open, blueprint, references, find_cxx_references, asset, 蓝图引用, 虚幻编辑器]
related_tools: [unreal_editor_find_references, unreal_editor_open, find_cxx_references, symbols, grep]
guide_for: [unreal_editor_find_references, unreal_editor_open]
version: 2
updated_at: 2026-11-27
---

## Preconditions

- The session workspace contains the project's `.uproject`.
- The Unreal Editor is open on that same `.uproject` and its unreal-editor MCP server is connected and ready. Protocol details: read_knowledge("unreal-editor/editor-bridge-protocol").
- Both tools are permission level 0. In Ask mode only `unreal_editor_find_references` is available.

## unreal_editor_find_references

Finds Blueprint references to a C++ class or function. It does NOT search C++ code — use `find_cxx_references` (or `symbols` / `grep`) for C++ call sites.

```json
{"kind": "function", "className": "AMyCharacter", "name": "StartSprint", "module": "MyGame", "limit": 50}
```

```json
{"kind": "class", "className": "UInventoryComponent"}
```

- `kind` (required): `function` | `class`. `className` (required): C++ class name with its prefix (`A…`, `U…`). `name`: function identifier, required for `function`. `module`: optional Unreal module. `limit`: 1–200, default 100.
- Output first line: `unreal-editor: <indexState> complete=<bool> hits=<n>[ skipped=<n>]`, then the symbol, then one line per hit:

```text
call asset=/Game/Characters/BP_Hero.BP_Hero graph=EventGraph graphGuid=… node=K2Node_CallFunction nodeGuid=… title=Start Sprint
```

- Hit kinds: `call`, `event_override`, `parent_class` (Blueprint subclasses), `cast`, `variable_type`, `class_pin`.
- `complete=false` / "Index is still building. This list is partial." — the editor is still indexing; say so and retry later before claiming there are no references.

## unreal_editor_open

```json
{"assetPath": "/Game/Characters/BP_Hero.BP_Hero", "graphGuid": "0123456789abcdef0123456789abcdef", "nodeGuid": "fedcba9876543210fedcba9876543210"}
```

- `assetPath` (required): soft object path (`/Game/Path/Asset.Asset`). `graphGuid` / `nodeGuid`: optional, 32 hex characters without dashes — copy them from the same find_references hit to select that node. With only `assetPath` the asset opens.
- Success: `unreal-editor: opened focus=node|graph|asset asset=…` (returnCode 0).
- Failure: `opened=false error=not_found` (returnCode 3), `invalid_target` (5), `unsupported` (1).

## Dev Mode → Find Usages panel

- Blueprint rows in the panel are interactive: a single click selects the asset in the Unreal Editor (needs the plugin's `select` capability, otherwise it falls back to opening the asset), a double click opens it at the reference node.
- No tool call is needed for that — the panel drives `unreal_editor_open` / `unreal_editor_select` directly. Use the tools yourself when the user asks you to open a Blueprint reference.

## Status lines and recovery

| Output | returnCode | Meaning / next step |
| --- | --- | --- |
| `unreal-editor: not_connected` — no workspace path | 3 | Session has no workspace |
| `unreal-editor: not_connected` — no Unreal project file | 3 | Workspace has no `.uproject`; wrong workspace |
| `unreal-editor: not_connected` — No Unreal Editor session matches … | 3 | Ask the user to open the editor on this project and connect its MCP server |
| `unreal-editor: not_ready` | 1 | Editor connected but still loading; wait and retry |
| `unreal-editor: invalid response` | 1 | Plugin speaks another protocol version |
| `Invalid arguments: …` | 5 | Fix kind / className / name / limit / GUID format |

- "Blueprint results were not queried" means nothing was searched — never report it as "no Blueprint references".

## Workflows

- Impact of changing a C++ function: `find_cxx_references` (C++ callers) + `unreal_editor_find_references kind=function` (Blueprint callers and overrides) → report both lists.
- Who subclasses a C++ class in Blueprint: `kind=class` and look for `parent_class` hits.
- Show the user a usage: take `assetPath` + `graphGuid` + `nodeGuid` from a hit and call `unreal_editor_open`.
