-- LOCAL PREPARATION ONLY. Production application requires approval.
-- Independent of specials/import records. No business data is modified.
CREATE TABLE IF NOT EXISTS facebook_alert_incidents (
  incident_key TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  scope TEXT NOT NULL,
  code TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('attention','pending','resolved','suppressed')),
  first_seen_ms INTEGER NOT NULL,
  observed_ms INTEGER NOT NULL,
  due_ms INTEGER NOT NULL,
  sent_ms INTEGER,
  dispatch_state TEXT NOT NULL DEFAULT 'ready' CHECK(dispatch_state IN ('ready','uncertain','sent')),
  authorized_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until_ms INTEGER,
  last_error TEXT CHECK(last_error IS NULL OR last_error='send_failed')
);
CREATE INDEX IF NOT EXISTS facebook_alert_due
  ON facebook_alert_incidents(day,state,sent_ms,due_ms);
