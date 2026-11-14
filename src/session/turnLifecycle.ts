import type { DatabaseSync } from "node:sqlite";
import type { Session } from "./types.js";

export type SessionTurnStopReason = "user_stopped" | "user_paused" | "coco_budget" | "coco_stopped" | "shutdown";
export type SessionTurnLifecycle = {
  sessionId: string; turnId: string; owner: "user" | "coco" | "coco_chat";
  startedAt: number; endedAt?: number; state: "running" | "completed" | "failed" | "interrupted" | SessionTurnStopReason;
  requestedStop?: SessionTurnStopReason; error?: string;
  pendingEffects: { toolCallId: string; toolName: string }[];
};

/** Main-process facts, separate from the model-editable transcript/blackboard. */
export class SessionTurnLifecycles {
  constructor(private db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS session_turn_lifecycle(session_id TEXT PRIMARY KEY,payload TEXT NOT NULL)");
  }
  get(sessionId: string): SessionTurnLifecycle | undefined {
    const row = this.db.prepare("SELECT payload FROM session_turn_lifecycle WHERE session_id=?").get(sessionId) as {payload:string}|undefined;
    return row ? JSON.parse(row.payload) as SessionTurnLifecycle : undefined;
  }
  put(value: SessionTurnLifecycle): void {
    this.db.prepare("INSERT INTO session_turn_lifecycle(session_id,payload) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET payload=excluded.payload").run(value.sessionId,JSON.stringify(value));
  }
  delete(sessionId: string): void {
    this.db.prepare("DELETE FROM session_turn_lifecycle WHERE session_id=?").run(sessionId);
  }
  requestStop(sessionId: string, reason: SessionTurnStopReason): void {
    const current=this.get(sessionId);if(current)this.put({...current,requestedStop:reason});
  }
  finish(session: Session, turnId: string, pendingEffects: SessionTurnLifecycle["pendingEffects"], error?: string): void {
    const current=this.get(session.id);if(!current || current.turnId!==turnId)return;
    const state=current.requestedStop ?? (session.status==="error"?"failed":session.status==="idle"||session.status==="completed"?"completed":"interrupted");
    this.put({...current,state,endedAt:Date.now(),pendingEffects,...(error?{error}:{})});
  }
}

const readOnly = new Set(["coco_context","read_coco_context","coco_job_input","submit_coco_result","read_file","list_dir","grep","glob","symbols","batch_search","get_workspace_path","get_current_time","read_image","display_image","read_skill","search_skills","search_tools","tool_describe","search_session_history","read_user_memory","read_project_memory","get_subagent_status","list_subagents"]);
export function unfinishedTurnEffects(session: Session, fromIndex: number): SessionTurnLifecycle["pendingEffects"] {
  const messages=session.messages.slice(fromIndex);
  const failed = new Set(messages.flatMap(m=>m.parts.flatMap(p=>p.type==="tool_result" && p.returnCode===1?[p.toolCallId]:[])));
  return messages.flatMap(m=>m.parts.flatMap(p=>p.type==="tool_call" && !readOnly.has(p.name) && (p.status==="running" || (p.status==="error" && failed.has(p.id))) ? [{toolCallId:p.id,toolName:p.name}] : []));
}
