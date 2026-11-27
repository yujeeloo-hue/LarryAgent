---
title: Managing MCP servers
category: tools-management
summary: "Create, update and delete MCP server connections (stdio or HTTP), how their tools are named and offered, and how to verify a new server."
keywords: [mcp, create_mcp_server, update_mcp_server, delete_mcp_server, stdio, http, sse, mcp server, 服务器, 连接]
related_tools: [create_mcp_server, update_mcp_server, delete_mcp_server, search_tools, tool_describe, tool_call]
guide_for: [create_mcp_server, update_mcp_server, delete_mcp_server]
version: 1
updated_at: 2026-11-27
---

## Basics

- MCP server profiles are app-global (stored in the tools config), managed on the Tools screen or with these tools.
- All three tools are permission level 1: they need Bypass permissions. If denied, call `request_full_permissions`, then retry.
- Only create servers from details the user provided or confirmed (command, package, URL, credentials). Never invent secrets.

## create_mcp_server

stdio (spawns a local process):

```json
{"name": "Filesystem", "transport": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/abs/dir"], "env": {"LOG_LEVEL": "info"}}
```

HTTP:

```json
{"name": "Docs search", "transport": "http", "url": "https://example.com/mcp", "headers": {"Authorization": "Bearer <token from user>"}}
```

- `transport` decides the field set: stdio uses `command`, `args` (array or space-separated string), `env`, `cwd` (absolute); http uses `url`, `headers`. Do not mix them.
- HTTP tries Streamable HTTP first and falls back to legacy SSE automatically.
- `enabled` (default true) connects immediately.

## update_mcp_server

- Identify by `id` (preferred) or `name`. `new_name` renames. `enabled` connects / disconnects.
- Passing `transport` replaces the whole transport; give the complete field set for it.

## delete_mcp_server

- By `id` (preferred) or `name`; disconnects and removes the profile.

## How MCP tools reach you

- Each advertised tool is registered as `mcp__{serverId}__{sanitizedToolName}`, default permission 0 (the user can change it per tool on the Tools screen).
- MCP tools are never in the eager `tools[]`. Use the bridge: `search_tools` (AND keywords) → `tool_describe` (full schema) → `tool_call` (`{ name, arguments }`).
- Resources, prompts and OAuth are not supported.

## Verifying a new server

1. Create it, then `search_tools` with a keyword from the server's purpose to confirm its tools are listed.
2. `tool_describe` one tool and make a harmless read-only `tool_call`.
3. If no tools appear: check the command runs in a shell (missing runtime such as node / uvx), the URL and headers, and that `enabled` is true; fix with `update_mcp_server`.
