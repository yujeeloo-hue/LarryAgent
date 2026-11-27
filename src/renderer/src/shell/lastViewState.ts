import type { AgentNavId } from "../navigation/types.js";

const STORAGE_KEY = "jellybot.shell.lastView.v1";

export type LastViewMode = "dev" | "normal";

export type LastView = {
  mode: LastViewMode;
  sessionId: string | null;
  workspaceId: string | null;
  nav: AgentNavId | null;
};

export type RestoreCandidateSession = {
  id: string;
  workspaceId?: string | undefined;
  archived?: boolean | undefined;
};

export type RestoreTarget =
  | {
      kind: "session";
      sessionId: string;
      workspaceId: string | null;
      mode: LastViewMode;
    }
  | { kind: "dev-new-task"; workspaceId: string | null }
  | { kind: "nav"; nav: AgentNavId }
  | { kind: "none" };

const NAV_IDS: readonly AgentNavId[] = [
  "new-task",
  "loop",
  "search",
  "tools",
  "skills",
  "graphs",
];

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNav(value: unknown): AgentNavId | null {
  return NAV_IDS.find((id) => id === value) ?? null;
}

export function readLastView(): LastView | null {
  const store = storage();
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  const mode = record.mode === "dev" || record.mode === "normal" ? record.mode : null;
  if (!mode) return null;
  return {
    mode,
    sessionId: readString(record.sessionId),
    workspaceId: readString(record.workspaceId),
    nav: readNav(record.nav),
  };
}

export function writeLastView(view: LastView): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(view));
  } catch {
  }
}

export function resolveRestoreTarget(
  last: LastView,
  sessions: readonly RestoreCandidateSession[],
): RestoreTarget {
  const session = last.sessionId
    ? sessions.find((item) => item.id === last.sessionId && !item.archived)
    : undefined;
  if (session) {
    return {
      kind: "session",
      sessionId: session.id,
      workspaceId: session.workspaceId ?? last.workspaceId,
      mode: last.mode,
    };
  }
  if (last.mode === "dev") {
    return { kind: "dev-new-task", workspaceId: last.workspaceId };
  }
  if (last.nav) return { kind: "nav", nav: last.nav };
  return { kind: "none" };
}


