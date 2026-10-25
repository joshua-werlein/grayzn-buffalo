-- LOCAL PREPARATION ONLY. Requires separate production approval after 0023.
-- Hashes and scan identities only. No poster text, addresses or provider errors.
ALTER TABLE facebook_alert_incidents ADD COLUMN proof_json TEXT;
CREATE TABLE facebook_alert_scans (
  day TEXT PRIMARY KEY,
  token TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  completed_ms INTEGER,
  evaluated_ms INTEGER,
  evaluation_state TEXT NOT NULL DEFAULT 'pending' CHECK(evaluation_state IN ('pending','complete','failed','skipped')),
  evaluation_error TEXT CHECK(evaluation_error IS NULL OR evaluation_error IN ('evaluation_failed','evidence_changed','outside_window')),
  source_ids TEXT,
  parser INTEGER NOT NULL
);
