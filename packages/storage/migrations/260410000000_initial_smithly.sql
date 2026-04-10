PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  default_branch TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE backlog_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_backlog_item_id TEXT REFERENCES backlog_items(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'approved', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority INTEGER NOT NULL DEFAULT 0,
  scope_summary TEXT,
  acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  review_mode TEXT NOT NULL CHECK (review_mode IN ('human', 'ai')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE worker_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  worker_kind TEXT NOT NULL CHECK (worker_kind IN ('claude', 'codex')),
  status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'waiting', 'blocked', 'exited', 'failed')),
  terminal_key TEXT,
  transcript_ref TEXT,
  started_at TEXT,
  ended_at TEXT,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  worker_session_id TEXT REFERENCES worker_sessions(id) ON DELETE SET NULL,
  assigned_worker TEXT NOT NULL CHECK (assigned_worker IN ('claude', 'codex')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'blocked', 'awaiting_review', 'done', 'failed', 'cancelled')),
  summary_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE blockers (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backlog_item_id TEXT REFERENCES backlog_items(id) ON DELETE SET NULL,
  task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  blocker_type TEXT NOT NULL CHECK (blocker_type IN ('policy', 'helper_model', 'human', 'system')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backlog_item_id TEXT REFERENCES backlog_items(id) ON DELETE SET NULL,
  task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  requested_by TEXT NOT NULL CHECK (requested_by IN ('system', 'claude', 'codex', 'human')),
  decision_by TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'deferred')),
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE chat_threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backlog_item_id TEXT REFERENCES backlog_items(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project_planning', 'task_planning', 'project_operator', 'task_operator')),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE chat_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('system', 'human', 'claude', 'codex', 'assistant', 'tool')),
  body_text TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE memory_notes (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  backlog_item_id TEXT REFERENCES backlog_items(id) ON DELETE SET NULL,
  task_run_id TEXT REFERENCES task_runs(id) ON DELETE SET NULL,
  source_thread_id TEXT REFERENCES chat_threads(id) ON DELETE SET NULL,
  note_type TEXT NOT NULL CHECK (note_type IN ('fact', 'decision', 'note', 'session_summary')),
  title TEXT NOT NULL,
  body_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE verification_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'cancelled')),
  command_text TEXT NOT NULL,
  summary_text TEXT,
  artifact_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE review_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_run_id TEXT NOT NULL REFERENCES task_runs(id) ON DELETE CASCADE,
  reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('human', 'claude', 'codex')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'approved', 'changes_requested', 'failed')),
  summary_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_backlog_items_project_status ON backlog_items(project_id, status);
CREATE INDEX idx_task_runs_project_status ON task_runs(project_id, status);
CREATE INDEX idx_blockers_project_status ON blockers(project_id, status);
CREATE INDEX idx_approvals_project_status ON approvals(project_id, status);
CREATE INDEX idx_chat_threads_project_kind ON chat_threads(project_id, kind);
CREATE INDEX idx_chat_messages_thread_created_at ON chat_messages(thread_id, created_at);
CREATE INDEX idx_memory_notes_project_type ON memory_notes(project_id, note_type);
CREATE INDEX idx_verification_runs_task_status ON verification_runs(task_run_id, status);
CREATE INDEX idx_review_runs_task_status ON review_runs(task_run_id, status);
