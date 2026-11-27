---
title: Unreal Editor push protocol (plugin implementation guide)
category: unreal-editor
summary: "How an Unreal Editor MCP plugin declares unreal-editor support at the MCP handshake and pushes status / heartbeat notifications so the app needs no polling."
keywords: [unreal, unreal editor, mcp, push, notification, heartbeat, status_push, handshake, experimental, plugin, 推送, 心跳]
related_tools: [unreal_editor_find_references, unreal_editor_open]
version: 2
updated_at: 2026-11-27
---

## When to use this doc

- You are writing or changing the MCP server plugin inside an Unreal project so that the editor announces itself and pushes its state to the app.
- Base protocol (tools, request / response shapes, binding rules): read_knowledge("unreal-editor/editor-bridge-protocol"). This doc only adds the push layer; everything there still applies.
- The push layer is optional and additive. Protocol id stays `unreal-editor`, `protocolVersion` stays `1`. A plugin without it keeps working in pull mode.

## Pull mode vs push mode

| Mode | How the app decides | How the app knows the editor is alive |
| --- | --- | --- |
| Pull | No valid handshake declaration | Calls `unreal_editor_capabilities` on connect; HTTP re-probes every 5 s |
| Push | Valid `experimental["unreal-editor"]` block containing `status_push` | Handshake declaration + status notifications; no polling |

- In push mode the plugin must **still** expose all three protocol tools, including `unreal_editor_capabilities` (the app calls it once when heartbeats stop).
- A declaration that is malformed or lacks `status_push` is ignored and the server is treated as pull mode.

## Handshake declaration

Return this in the MCP `initialize` result under `capabilities.experimental`:

```json
{
  "protocolVersion": "2025-03-26",
  "serverInfo": {"name": "MyGame-UnrealEditor", "version": "1.0.0"},
  "capabilities": {
    "tools": {"listChanged": true},
    "experimental": {
      "unreal-editor": {
        "protocol": "unreal-editor",
        "protocolVersion": 1,
        "projectFile": "D:/Proj/MyGame/MyGame.uproject",
        "engineVersion": "5.4.4",
        "ready": false,
        "capabilities": ["references", "open", "status_push"],
        "heartbeatIntervalMs": 10000
      }
    }
  }
}
```

- Fields follow the same rules as the `unreal_editor_capabilities` reply: exact `protocol` / `protocolVersion`, non-empty absolute `projectFile` (the `.uproject` of the running editor), string `engineVersion`, boolean `ready`, `capabilities` containing `references` and `open`. Push mode additionally requires `status_push`. Optional capability `select` (select an asset without opening it) must be declared here too — the app reads capabilities from the handshake in push mode.
- `heartbeatIntervalMs`: optional integer 1000–60000, default 10000. Out of range → default.
- `ready` means the editor can answer `find_references` / `open` right now (engine init finished, editor subsystems up). Asset-index progress is reported separately via `indexState` in find_references, not here.
- Declare `tools.listChanged: true` only if you actually send `notifications/tools/list_changed`.

## Status notification

Method `notifications/unreal-editor/status` (a JSON-RPC notification: no `id`, no response):

```json
{"jsonrpc": "2.0", "method": "notifications/unreal-editor/status",
 "params": {"protocol": "unreal-editor", "protocolVersion": 1,
            "projectFile": "D:/Proj/MyGame/MyGame.uproject", "engineVersion": "5.4.4",
            "ready": true, "capabilities": ["references", "open", "status_push"],
            "heartbeatIntervalMs": 10000}}
```

- `params` uses the handshake block's shape (all required fields every time, including `status_push` in `capabilities`; it is a full snapshot, not a delta). Optional `shuttingDown: true`.
- Invalid params are ignored by the app (they neither refresh nor break the binding), so a bad payload looks like a missed heartbeat.

### When to send

| Moment | Payload |
| --- | --- |
| Right after the client sends `notifications/initialized`, if `ready` differs from the handshake value | current snapshot |
| Editor becomes able to serve requests | `ready: true` |
| Editor temporarily cannot serve (e.g. long blocking operation you choose to report) | `ready: false` |
| Every `heartbeatIntervalMs` with no other status sent | current snapshot (heartbeat) |
| Editor shutting down (before the MCP transport closes) | `ready: false, shuttingDown: true` |

- Any status notification counts as a heartbeat; you do not need a separate heartbeat after a state-change send.
- Send to **every** connected MCP session (each client connection has its own session).

## App behavior you can rely on

- Valid declaration → bound immediately, no tool call.
- Valid status → binding updated (`ready`, `projectFile`, `engineVersion`), heartbeat timer reset. `ready=false` keeps the binding; the app's tools then report `unreal-editor: not_ready`.
- `shuttingDown: true` → binding dropped at once.
- No valid status for `3 × heartbeatIntervalMs` → the app calls `unreal_editor_capabilities` once (3 s timeout). Success keeps the binding; failure drops it and rebuilds the MCP connection (fresh `initialize`).
- `notifications/tools/list_changed` → the app re-lists tools and re-runs the binding, keeping the last pushed status (the handshake snapshot is not re-applied).
- A status pushed before the app finishes its connect sequence is kept and wins over the handshake snapshot.
- Status notifications from a server that did not declare push mode are ignored.
- Reconnect is automatic: a server that fails to connect or closes is retried (5 s, doubling, capped at 60 s), so an editor started after the app, or restarted as a different build, is picked up without a manual refresh. Every reconnect re-reads the handshake, so the new process decides push vs pull mode.

## Transport requirements

- **Streamable HTTP**: server-initiated notifications travel on the stream the client opens with `GET` on the MCP endpoint (`Accept: text/event-stream`, `Mcp-Session-Id` header). The server must support that GET stream and keep it open; answering `405` means the app receives no pushes. Notifications must carry the session the stream belongs to.
- **Legacy HTTP+SSE** and **stdio**: notifications go on the existing SSE stream / stdout. On stdio, never write logs to stdout — it corrupts the JSON-RPC stream; use `UE_LOG` / stderr.
- Without working push delivery the app silently degrades to one capabilities probe every `3 × heartbeatIntervalMs`. If you see that, check the GET stream first.

## Unreal-side hook points

Suggested places to trigger status sends (UE5 names; adjust for the project's engine version):

| Event | Hook |
| --- | --- |
| Editor ready | `FCoreDelegates::OnPostEngineInit` (or `FEditorDelegates::OnEditorInitialized` where available) |
| Heartbeat | `FTSTicker::GetCoreTicker().AddTicker(...)` with `heartbeatIntervalMs / 1000.f` (UE4: `FTicker`) |
| Shutdown | `FCoreDelegates::OnEnginePreExit` (send `shuttingDown`, then close the transport) |
| Optional busy states | `FEditorDelegates::PreBeginPIE` / `EndPIE`, only if your tools really cannot serve during PIE |

- Asset registry readiness (`IAssetRegistry::OnFilesLoaded`) affects `indexState` in find_references, not `ready`.
- Threading: editor state must be read on the game thread; network writes usually happen on the server's own thread. Build the JSON snapshot on the game thread, then hand the string to the transport thread (`AsyncTask(ENamedThreads::GameThread, ...)` in the other direction when a request needs editor data).
- Keep one function that builds the snapshot and reuse it for the handshake block, every status notification and the `unreal_editor_capabilities` reply, so the three never disagree.
- Normalize `projectFile` with `FPaths::ConvertRelativePathToFull(FPaths::GetProjectFilePath())` and forward slashes.

## Conformance checklist

1. `initialize` result contains `capabilities.experimental["unreal-editor"]` with every required field and `status_push`.
2. `unreal_editor_capabilities`, `unreal_editor_find_references`, `unreal_editor_open` still exist and match editor-bridge-protocol.
3. Handshake block, status params and the capabilities tool reply come from the same snapshot builder.
4. A status notification is sent at least every `heartbeatIntervalMs` while connected.
5. `ready` flips to `true` with a notification once the editor can serve requests.
6. On editor exit a `shuttingDown: true` status is sent before the transport closes.
7. HTTP: `GET` on the MCP endpoint opens an SSE stream (not `405`), and notifications appear on it.
8. stdio: nothing but JSON-RPC on stdout.

## Verifying against the app

- Connect the server in the Tools screen. With the editor still starting (`ready: false`), `unreal_editor_find_references` must report `not_ready`, then succeed shortly after the `ready: true` push — without waiting 5 s.
- Stop sending heartbeats (e.g. pause the ticker in a debug build): after about `3 × heartbeatIntervalMs` the app calls `unreal_editor_capabilities` exactly once.
- Close the editor normally: the binding disappears immediately (the tools report `not_connected`).
