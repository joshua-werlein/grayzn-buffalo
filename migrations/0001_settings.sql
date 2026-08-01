-- Settings: single key/value store for site-wide toggles and copy.
-- Reusable for the delivery pause switch, happy-hour notice, holiday hours, etc.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Seed separately managed announcement slots and a delivery-status toggle.
INSERT INTO settings (key, value) VALUES
 ('announcement_1', ''),
 ('announcement_2', ''),
 ('announcement_3', ''),
 ('delivery_paused', '0')
ON CONFLICT(key) DO NOTHING;
