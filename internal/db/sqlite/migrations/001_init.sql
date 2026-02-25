-- Agents
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  heartbeat_interval TEXT,
  heartbeat_enabled INTEGER DEFAULT 0,
  quiet_hours TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Conversation memory with trust tags (per-agent)
CREATE TABLE IF NOT EXISTS memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user',
  trust TEXT NOT NULL DEFAULT 'trusted',
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  deleted INTEGER DEFAULT 0
);

-- Channel → agent bindings
CREATE TABLE IF NOT EXISTS bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  server TEXT,
  contact TEXT,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  priority INTEGER DEFAULT 0
);

-- Domain allowlist
CREATE TABLE IF NOT EXISTS domain_allowlist (
  domain TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  granted_by TEXT DEFAULT 'user',
  granted_at TEXT DEFAULT (datetime('now')),
  last_accessed TEXT,
  access_count INTEGER DEFAULT 0,
  requested_by TEXT,
  notes TEXT
);

-- Skill registry
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  version TEXT NOT NULL,
  author_id TEXT NOT NULL,
  author_pubkey TEXT,
  signature TEXT,
  scan_result TEXT,
  scan_date TEXT,
  flagged INTEGER DEFAULT 0,
  approved INTEGER DEFAULT 0,
  approved_at TEXT,
  disabled INTEGER DEFAULT 0,
  path TEXT NOT NULL
);

-- Trusted author keys
CREATE TABLE IF NOT EXISTS trusted_authors (
  pubkey TEXT PRIMARY KEY,
  name TEXT,
  trusted_at TEXT DEFAULT (datetime('now')),
  trust_reason TEXT
);

-- Audit log: append-only, never deleted
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT DEFAULT (datetime('now')),
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  trust_level TEXT NOT NULL DEFAULT 'trusted',
  approved_by TEXT,
  domain TEXT
);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_version (version) VALUES (1);
