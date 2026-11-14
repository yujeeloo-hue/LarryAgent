export interface ConnectionState {
  socket: "online" | "connecting" | "offline";
  e2ee: "" | "on" | "err";
  e2eeTitle: string;
}

/** A green shield requires both a live socket and an encrypted stream. */
export function connectionStatus(state: ConnectionState, onlineCount: number) {
  const status = state.socket === "online" ? "Connected"
    : state.socket === "connecting" ? "Connecting…" : "Offline — reconnecting…";
  const shield = state.socket === "offline" ? "off"
    : state.socket === "connecting" ? "wait"
      : state.e2ee === "err" ? "err" : state.e2ee === "on" ? "on" : "wait";
  const title = state.socket !== "online" ? status
    : state.e2eeTitle || "Connected — waiting for stream encryption";
  return { status, shield, title,
    count: state.socket === "online" ? `${onlineCount} device${onlineCount === 1 ? "" : "s"} online` : "" };
}
