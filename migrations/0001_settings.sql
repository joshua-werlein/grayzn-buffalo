-- Settings: single key/value store for site-wide toggles and copy.
-- Reusable for the delivery pause switch, happy-hour notice, holiday hours, etc.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Seed the announcement row empty so the banner stays hidden until staff set it.
INSERT INTO settings (key, value) VALUES ('announcement', '')
  ON CONFLICT(key) DO NOTHING;