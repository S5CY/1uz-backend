CREATE TABLE IF NOT EXISTS answer_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  story_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  scene TEXT NOT NULL,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  client_timestamp TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_answer_events_story_id ON answer_events(story_id);
CREATE INDEX IF NOT EXISTS idx_answer_events_created_at ON answer_events(created_at DESC);

CREATE TABLE IF NOT EXISTS progress_snapshots (
  story_id TEXT PRIMARY KEY,
  scene TEXT NOT NULL,
  affection INTEGER NOT NULL DEFAULT 10,
  memory_111_complete INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
