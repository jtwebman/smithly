CREATE TABLE backlog_dependencies (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  blocking_backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  blocked_backlog_item_id TEXT NOT NULL REFERENCES backlog_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (blocking_backlog_item_id, blocked_backlog_item_id),
  CHECK (blocking_backlog_item_id <> blocked_backlog_item_id)
);

INSERT INTO backlog_dependencies (
  project_id,
  blocking_backlog_item_id,
  blocked_backlog_item_id,
  created_at,
  updated_at
)
SELECT
  child.project_id,
  child.parent_backlog_item_id,
  child.id,
  child.created_at,
  child.updated_at
FROM backlog_items child
WHERE child.parent_backlog_item_id IS NOT NULL;

CREATE INDEX idx_backlog_dependencies_project_blocked
ON backlog_dependencies(project_id, blocked_backlog_item_id);

CREATE INDEX idx_backlog_dependencies_project_blocking
ON backlog_dependencies(project_id, blocking_backlog_item_id);
