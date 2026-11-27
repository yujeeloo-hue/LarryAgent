import type { DaemonDisplay } from "./LoopView.js";

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false });
}

export function daemonToDisplay(status: LoopsDaemonView): DaemonDisplay {
  if (status.inApp) {
    if (status.state === "running") {
      const parts: string[] = [];
      if (status.pid != null) parts.push(`pid ${status.pid}`);
      if (status.daemonVersion) parts.push(`v${status.daemonVersion}`);
      if (status.heartbeatAt != null) {
        parts.push(`heartbeat ${formatClock(status.heartbeatAt)}`);
      } else {
        parts.push("no heartbeat yet");
      }
      return {
        tone: status.heartbeatStale ? "stale" : "running",
        label: status.heartbeatStale ? "Heartbeat stale" : "Running",
        detail: parts.join(" · "),
        action: "stop",
        actionLabel: "Stop",
      };
    }
    return {
      tone: "stopped",
      label: "Stopped",
      detail: status.stoppedByUser
        ? "Stopped from the app — loops only run while the scheduler is started."
        : "Scheduler not running — loops will start when JellyBot is open.",
      action: "ensure",
      actionLabel: "Start",
    };
  }
  if (status.state === "running") {
    const parts: string[] = [];
    if (status.pid != null) parts.push(`pid ${status.pid}`);
    if (status.daemonVersion) parts.push(`v${status.daemonVersion}`);
    if (status.heartbeatAt != null) {
      parts.push(`heartbeat ${formatClock(status.heartbeatAt)}`);
    } else {
      parts.push("no heartbeat yet");
    }
    if (status.heartbeatStale) {
      return {
        tone: "stale",
        label: "Heartbeat stale",
        detail: parts.join(" · "),
        action: "stop",
        actionLabel: "Stop",
      };
    }
    return {
      tone: "running",
      label: "Running",
      detail: parts.join(" · "),
      action: "stop",
      actionLabel: "Stop",
    };
  }
  if (status.plistExists) {
    if (status.stoppedByUser) {
      return {
        tone: "stopped",
        label: "Stopped",
        detail:
          "Stopped from the app — loops only run while the daemon is started.",
        action: "ensure",
        actionLabel: "Start",
      };
    }
    const parts: string[] = [];
    if (status.state) parts.push(`launchd: ${status.state}`);
    if (status.lastError) parts.push(`last error: ${status.lastError}`);
    return {
      tone: "stopped",
      label: "Stopped",
      detail: parts.length > 0 ? parts.join(" · ") : "Installed but not running",
      action: "ensure",
      actionLabel: "Start",
    };
  }
  return {
    tone: "missing",
    label: "Not installed",
    detail:
      "The background scheduler is not installed. Install it to keep loops running while JellyBot is closed.",
    action: "ensure",
    actionLabel: "Install & Enable",
  };
}
