import {
  mcpManager,
  type McpManager,
  type McpServerConnection,
  type McpToolInvoker,
} from "../mcp/manager.js";
import { agentLogWarn } from "../logging/agentLog.js";
import { forgetUnrealEditor, listUnrealEditors, rememberUnrealEditor } from "./editorBinding.js";
import { toolResultText } from "./editorClient.js";
import {
  UNREAL_EDITOR_CAPABILITIES_TOOL,
  UNREAL_EDITOR_PROTOCOL_TOOLS,
  UNREAL_EDITOR_STATUS_NOTIFICATION,
  parseUnrealEditorCapabilities,
  parseUnrealEditorPushDeclaration,
  parseUnrealEditorStatus,
  projectFileKey,
  type UnrealEditorCapabilities,
  type UnrealEditorStatus,
} from "./editorProtocol.js";

const HTTP_PROBE_INTERVAL_MS = 5_000;
const HTTP_PROBE_TIMEOUT_MS = 3_000;
const HEARTBEAT_MISS_FACTOR = 3;
const SILENT_PUSH_RESCUES = 2;

type PushSession = {
  callTool: McpToolInvoker;
  stillCurrent: () => boolean;
  reconnect: () => void;
  connectedAt: number;
  heartbeatIntervalMs: number;
  lastStatus: UnrealEditorStatus;
  timer: ReturnType<typeof setTimeout> | null;
  rescues: number;
  silentLogged: boolean;
};

export async function bindUnrealEditorSession(
  serverId: string,
  toolNames: readonly string[],
  callTool: McpToolInvoker,
  stillCurrent: () => boolean,
  now = Date.now(),
  signal?: AbortSignal,
): Promise<boolean> {
  if (!stillCurrent()) return false;
  if (!toolNames.includes(UNREAL_EDITOR_CAPABILITIES_TOOL)) {
    forgetUnrealEditor(serverId);
    return false;
  }
  const parsed = await queryCapabilities(callTool, signal);
  if (!stillCurrent()) return false;
  if (!parsed) {
    forgetUnrealEditor(serverId);
    return false;
  }
  rememberBinding(serverId, parsed, "probe", now, Date.now());
  return true;
}

function isBound(serverId: string): boolean {
  return listUnrealEditors().some((binding) => binding.serverId === serverId);
}

export function installUnrealEditorMcp(manager: McpManager = mcpManager): void {
  const httpTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pushSessions = new Map<string, PushSession>();
  const pendingStatus = new Map<string, UnrealEditorStatus>();

  const stopServer = (serverId: string): void => {
    clearTimeout(httpTimers.get(serverId));
    httpTimers.delete(serverId);
    const session = pushSessions.get(serverId);
    if (session?.timer) clearTimeout(session.timer);
    pushSessions.delete(serverId);
  };

  const armWatchdog = (serverId: string, session: PushSession): void => {
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
    if (!session.stillCurrent()) return;
    const timer = setTimeout(() => {
      session.timer = null;
      void rescue(serverId, session);
    }, session.heartbeatIntervalMs * HEARTBEAT_MISS_FACTOR);
    timer.unref();
    session.timer = timer;
  };

  const rescue = async (serverId: string, session: PushSession): Promise<void> => {
    if (!session.stillCurrent() || pushSessions.get(serverId) !== session) return;
    let parsed: UnrealEditorCapabilities | null = null;
    try {
      parsed = await queryCapabilities(
        session.callTool,
        AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
      );
    } catch {
      parsed = null;
    }
    if (!session.stillCurrent() || pushSessions.get(serverId) !== session) return;
    if (!parsed) {
      const wasBound = isBound(serverId);
      forgetUnrealEditor(serverId);
      if (wasBound) session.reconnect();
      return;
    }
    rememberBinding(serverId, parsed, "push", session.connectedAt, Date.now());
    session.rescues += 1;
    if (session.rescues >= SILENT_PUSH_RESCUES && !session.silentLogged) {
      session.silentLogged = true;
      agentLogWarn("unreal.push_silent", {
        serverId,
        heartbeatIntervalMs: session.heartbeatIntervalMs,
      });
    }
    armWatchdog(serverId, session);
  };

  const applyStatus = (
    serverId: string,
    session: PushSession,
    status: UnrealEditorStatus,
  ): void => {
    session.lastStatus = status;
    session.heartbeatIntervalMs = status.heartbeatIntervalMs;
    session.rescues = 0;
    if (status.shuttingDown) {
      if (session.timer) clearTimeout(session.timer);
      session.timer = null;
      forgetUnrealEditor(serverId);
      return;
    }
    rememberBinding(serverId, status, "push", session.connectedAt, Date.now());
    armWatchdog(serverId, session);
  };

  const connectPush = (
    connection: McpServerConnection,
    declared: UnrealEditorStatus,
    previous: PushSession | undefined,
  ): void => {
    const { serverId } = connection;
    const initial = pendingStatus.get(serverId) ?? previous?.lastStatus ?? declared;
    pendingStatus.delete(serverId);
    const session: PushSession = {
      callTool: connection.callTool,
      stillCurrent: connection.stillCurrent,
      reconnect: connection.reconnect,
      connectedAt: previous?.connectedAt ?? Date.now(),
      heartbeatIntervalMs: initial.heartbeatIntervalMs,
      lastStatus: initial,
      timer: null,
      rescues: 0,
      silentLogged: previous?.silentLogged ?? false,
    };
    pushSessions.set(serverId, session);
    applyStatus(serverId, session, initial);
  };

  const connectPull = async (connection: McpServerConnection): Promise<void> => {
    const { serverId, toolNames, callTool, stillCurrent, transport, reconnect } = connection;
    const connectedAt = Date.now();
    await bindUnrealEditorSession(serverId, toolNames, callTool, stillCurrent, connectedAt);
    if (transport !== "http" || !toolNames.includes(UNREAL_EDITOR_CAPABILITIES_TOOL)) return;

    // An idle HTTP transport may not report a server shutdown.
    const schedule = (): void => {
      if (!stillCurrent()) return;
      const timer = setTimeout(() => {
        httpTimers.delete(serverId);
        void recheck();
      }, HTTP_PROBE_INTERVAL_MS);
      timer.unref();
      httpTimers.set(serverId, timer);
    };
    const recheck = async (): Promise<void> => {
      const wasBound = isBound(serverId);
      let bound = false;
      try {
        bound = await bindUnrealEditorSession(
          serverId, toolNames, callTool, stillCurrent, connectedAt,
          AbortSignal.timeout(HTTP_PROBE_TIMEOUT_MS),
        );
      } catch {
        if (stillCurrent()) forgetUnrealEditor(serverId);
      }
      if (!stillCurrent()) return;
      if (wasBound && !bound) {
        reconnect();
        return;
      }
      schedule();
    };
    schedule();
  };

  manager.setHiddenMcpToolNames(UNREAL_EDITOR_PROTOCOL_TOOLS);
  manager.setMcpServerProbe({
    async onConnected(connection) {
      const { serverId, toolNames, serverCapabilities } = connection;
      const previous = pushSessions.get(serverId);
      stopServer(serverId);
      if (!connection.stillCurrent()) return;
      const declaration = parseUnrealEditorPushDeclaration(serverCapabilities);
      const pushReady =
        declaration.kind === "push" && toolNames.includes(UNREAL_EDITOR_CAPABILITIES_TOOL);
      if (pushReady) {
        connectPush(connection, declaration.status, previous);
        return;
      }
      if (declaration.kind !== "none") {
        agentLogWarn("unreal.push_declaration_invalid", {
          serverId,
          reason: declaration.kind === "invalid" ? "malformed" : "missing_capabilities_tool",
        });
      }
      pendingStatus.delete(serverId);
      await connectPull(connection);
    },
    onDisconnected: (serverId) => {
      stopServer(serverId);
      pendingStatus.delete(serverId);
      forgetUnrealEditor(serverId);
    },
    onNotification: (serverId, method, params) => {
      if (method !== UNREAL_EDITOR_STATUS_NOTIFICATION) return;
      const status = parseUnrealEditorStatus(params);
      if (!status) {
        agentLogWarn("unreal.push_status_invalid", { serverId });
        return;
      }
      const session = pushSessions.get(serverId);
      if (!session) {
        pendingStatus.set(serverId, status);
        return;
      }
      if (!session.stillCurrent()) return;
      applyStatus(serverId, session, status);
    },
  });
}

async function queryCapabilities(
  callTool: McpToolInvoker,
  signal?: AbortSignal,
): Promise<UnrealEditorCapabilities | null> {
  const result = await callTool(UNREAL_EDITOR_CAPABILITIES_TOOL, {}, signal);
  if (result.returnCode !== 0) return null;
  return parseUnrealEditorCapabilities(toolResultText(result));
}

function rememberBinding(
  serverId: string,
  capabilities: UnrealEditorCapabilities,
  source: "push" | "probe",
  connectedAt: number,
  lastSeenAt: number,
): void {
  rememberUnrealEditor({
    serverId,
    projectFile: capabilities.projectFile,
    projectKey: projectFileKey(capabilities.projectFile),
    engineVersion: capabilities.engineVersion,
    ready: capabilities.ready,
    capabilities: [...capabilities.capabilities],
    connectedAt,
    source,
    lastSeenAt,
  });
}
