/** SQLite schema version for session persistence. */
export const SESSION_DB_SCHEMA_VERSION = 25;

export const SESSION_DB_FILENAME = "sessions.sqlite";

export const SESSION_DB_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'user',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'app',
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  progress_text TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_id TEXT NOT NULL DEFAULT '',
  workspace_id TEXT NOT NULL DEFAULT '',
  workspace_path TEXT NOT NULL,
  pinned INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  context_usage TEXT NOT NULL,
  plan TEXT,
  plan_doc TEXT,
  phase TEXT,
  pending_user_ask TEXT,
  run_mode TEXT,
  infinite INTEGER,
  reasoning_max INTEGER,
  reasoning_effort TEXT,
  fsm_last_graph_mode TEXT,
  fsm_last_node_id TEXT,
  fsm_last_node_at INTEGER,
  fsm_graph_id TEXT,
  fsm_last_graph_id TEXT,
  fsm_blackboard TEXT,
  handoff_enabled INTEGER
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tool_call_id TEXT,
  parts TEXT NOT NULL,
  position INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_position
  ON messages(session_id, position);

CREATE TABLE IF NOT EXISTS subagent_runs (
  id TEXT PRIMARY KEY NOT NULL,
  parent_session_id TEXT NOT NULL,
  parent_tool_call_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  role TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 50,
  status TEXT NOT NULL,
  progress_text TEXT NOT NULL,
  result_summary TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent
  ON subagent_runs(parent_session_id);

CREATE TABLE IF NOT EXISTS subagent_messages (
  id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tool_call_id TEXT,
  parts TEXT NOT NULL,
  position INTEGER NOT NULL,
  FOREIGN KEY (run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_subagent_messages_run_position
  ON subagent_messages(run_id, position);

CREATE TABLE IF NOT EXISTS tool_invocations (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  parent_session_id TEXT,
  subagent_id TEXT,
  tool_call_id TEXT NOT NULL,
  name TEXT NOT NULL,
  is_mcp INTEGER NOT NULL DEFAULT 0,
  mcp_server_id TEXT,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  return_code INTEGER,
  started_at INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  scene_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_name
  ON tool_invocations(name);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_status
  ON tool_invocations(status);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_started
  ON tool_invocations(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_name_status
  ON tool_invocations(name, status);

CREATE TABLE IF NOT EXISTS session_history (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  workspace_id TEXT NOT NULL DEFAULT '',
  workspace_name TEXT NOT NULL DEFAULT '',
  workspace_path TEXT NOT NULL DEFAULT '',
  provider_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  device_id TEXT NOT NULL DEFAULT '',
  device_name TEXT NOT NULL DEFAULT '',
  device_os TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  session_created_at INTEGER NOT NULL,
  session_updated_at INTEGER NOT NULL,
  first_message_at INTEGER,
  last_message_at INTEGER,
  deleted_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  summary TEXT,
  summary_source TEXT,
  input_truncated INTEGER NOT NULL DEFAULT 0,
  summary_model TEXT,
  summarized_at INTEGER,
  payload TEXT,
  pushed_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_session_history_status_next
  ON session_history(status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_session_history_workspace
  ON session_history(workspace_id, session_created_at);

CREATE INDEX IF NOT EXISTS idx_session_history_session_id
  ON session_history(session_id);

CREATE TABLE IF NOT EXISTS memory_sync_state (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);
`;
