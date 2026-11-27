---
title: Unreal Editor bridge protocol
category: unreal-editor
summary: "How the app discovers an Unreal Editor through an MCP server speaking the unreal-editor protocol v1, binds it to a .uproject, and the exact request / response shapes."
keywords: [unreal, unreal editor, protocol, mcp, unreal_editor_capabilities, uproject, binding, blueprint, select, 虚幻编辑器, 协议]
related_tools: [unreal_editor_find_references, unreal_editor_open, find_cxx_references]
version: 3
updated_at: 2026-11-27
---

## Architecture

- The Unreal Editor side runs an MCP server (a plugin inside the editor). The user connects it like any other MCP server (Tools screen or `create_mcp_server`, usually HTTP).
- The app recognizes it as an editor either from a push declaration in the MCP `initialize` result (push mode) or, failing that, from the protocol tools below plus a valid `unreal_editor_capabilities` reply (pull mode). Those raw protocol tools are hidden from the agent's tool list; the agent uses the built-in wrappers `unreal_editor_find_references` and `unreal_editor_open` instead (see read_knowledge("unreal-editor/editor-tools")).
- Protocol id `unreal-editor`, version `1`.

| MCP tool on the editor | Purpose |
| --- | --- |
| `unreal_editor_capabilities` | Handshake: which project, engine, readiness |
| `unreal_editor_find_references` | Blueprint references to a C++ class / function |
| `unreal_editor_open` | Open an asset, optionally focusing a graph / node |
| `unreal_editor_select` | Select an asset in the Content Browser without opening it (optional capability `select`) |

## Handshake and binding

- Pull mode (no valid push declaration): on every MCP connect the app calls `unreal_editor_capabilities` (no args). A valid reply:

```json
{"protocol": "unreal-editor", "protocolVersion": 1, "projectFile": "D:/Proj/MyGame.uproject", "engineVersion": "5.4.4", "ready": true, "capabilities": ["references", "open"]}
```

- Rejected (server not bound) when: wrong protocol or version, empty `projectFile`, non-string `engineVersion`, non-boolean `ready`, or `capabilities` missing `references` or `open`.
- Optional capabilities: `select` (the editor can select an asset without opening it), `status_push` (push mode, see the push protocol doc). Declaring an optional capability is what unlocks the matching call — the app never calls a tool the plugin did not advertise.
- A valid reply records a binding `{ serverId, projectFile, projectKey, engineVersion, ready, capabilities, connectedAt, source, lastSeenAt }` (`source` = `probe` in pull mode, `push` in push mode; `lastSeenAt` = last valid reply or push). `projectKey` is the normalized absolute `.uproject` path (forward slashes; lower-cased on Windows).
- HTTP servers are re-probed every 5 s (3 s timeout) because an idle HTTP transport may not report shutdown; a failed probe or disconnect forgets the binding. Losing a bound editor rebuilds the MCP connection, and failed / closed connections are retried automatically (5 s, doubling, capped at 60 s), so a restarted editor is picked up without a manual refresh.
- That is **pull mode**. A plugin may instead declare the protocol in the MCP `initialize` result and push status / heartbeat notifications (**push mode**, capability `status_push`); the app then binds without calling `unreal_editor_capabilities` and stops the 5 s probe. See read_knowledge("unreal-editor/editor-push-protocol").

## Choosing the editor for a session

- The session workspace's `.uproject` is located; its key must equal a binding's `projectKey`.
- Several matching editors: prefer `ready=true`, then the most recent `connectedAt`.
- No `.uproject`, no matching editor, or editor not ready → the wrapper tools return a clear status without querying (see editor-tools).

## find_references request / response

Request sent to the editor:

```json
{"kind": "function", "className": "AMyCharacter", "name": "Jump", "module": "MyGame", "limit": 100}
```

Response:

```json
{"protocolVersion": 1, "indexState": "ready", "complete": true, "skipped": 0,
 "references": [{"kind": "call", "assetPath": "/Game/BP_Hero.BP_Hero", "graph": "EventGraph", "graphGuid": "<32 hex>", "nodeClass": "K2Node_CallFunction", "nodeGuid": "<32 hex>", "nodeTitle": "Jump"}]}
```

- `indexState`: `ready` | `warming` | `unavailable`. `complete=false` means the asset index is still building and the list is partial.
- Reference `kind`: `call` | `event_override` | `parent_class` | `cast` | `variable_type` | `class_pin`.
- Malformed references (bad kind, asset path not starting with `/` or lacking `.`) are dropped and counted in `skipped`. GUIDs that are not 32 hex characters are omitted.

## open request / response

```json
{"assetPath": "/Game/BP_Hero.BP_Hero", "graphGuid": "<32 hex>", "nodeGuid": "<32 hex>"}
```

- Success: `{"protocolVersion": 1, "opened": true, "assetPath": "…", "focus": "node" | "graph" | "asset"}`.
- Failure: `{"protocolVersion": 1, "opened": false, "assetPath": "…", "error": "not_found" | "unsupported" | "invalid_target"}`.

## select request / response

Only called when the plugin advertises the `select` capability. It must select the asset in the Content Browser (sync the browser to it, highlight it) and must not open an asset editor or a Blueprint graph.

```json
{"assetPath": "/Game/BP_Hero.BP_Hero"}
```

- Success: `{"protocolVersion": 1, "selected": true, "assetPath": "…"}`.
- Failure: `{"protocolVersion": 1, "selected": false, "assetPath": "…", "error": "not_found" | "unsupported"}`.
- The app uses it for a single click on a Blueprint row in Dev Mode → Find Usages; a double click keeps using `open` with the reference `graphGuid` / `nodeGuid`. When the plugin does not advertise `select`, that single click falls back to `open` with only `assetPath`.

## Invalid replies

- Any reply that does not parse as the expected JSON shape is reported as `unreal-editor: invalid response` with the first 500 characters of the body. Usually a plugin version mismatch — the editor plugin must implement protocol version 1.
