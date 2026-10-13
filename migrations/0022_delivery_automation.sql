-- Temporary evidence only. Never rewrite staff delivery_display settings.
CREATE TABLE IF NOT EXISTS delivery_automation (
  id INTEGER PRIMARY KEY CHECK (id=1),
  day TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)),
  expires_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  source_ids TEXT NOT NULL DEFAULT '[]'
);
