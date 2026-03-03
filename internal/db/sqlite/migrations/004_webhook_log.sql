-- Webhook delivery log for audit and replay
CREATE TABLE IF NOT EXISTS webhook_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  webhook TEXT NOT NULL,
  headers TEXT,
  body TEXT NOT NULL,
  source_ip TEXT,
  signature_valid INTEGER,
  agent_id TEXT,
  processed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
