ALTER TABLE backlog_items
ADD COLUMN readiness TEXT NOT NULL DEFAULT 'not_ready' CHECK (readiness IN ('not_ready', 'ready'));

UPDATE backlog_items
SET readiness = CASE
  WHEN status IN ('approved', 'in_progress', 'blocked', 'done', 'cancelled') THEN 'ready'
  ELSE 'not_ready'
END;

CREATE INDEX idx_backlog_items_project_status_readiness
ON backlog_items(project_id, status, readiness);
