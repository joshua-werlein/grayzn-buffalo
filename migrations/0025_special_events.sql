-- LOCAL PREPARATION ONLY. Production application requires separate approval,
-- after 0023 and 0024 are applied and a fresh backup is verified.
-- Additive: no existing table, row or constraint changes. Plain CREATE so an
-- accidental replay fails loudly instead of silently succeeding.
-- One-time promotions (game days, holidays, special events) live outside the
-- weekly specials collections and never change the weekly revision fence.
CREATE TABLE special_events (
  id TEXT PRIMARY KEY CHECK(id GLOB 'evt:*'),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 80),
  event_date TEXT NOT NULL CHECK(event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Printed label, e.g. "Tonight" or "11am-2pm".
  time_text TEXT NOT NULL DEFAULT '' CHECK(length(time_text)<=80),
  -- Optional Chicago wall-clock window. Without end_time an event ends at midnight.
  start_time TEXT CHECK(start_time IS NULL OR start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time TEXT CHECK(end_time IS NULL OR end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  details TEXT NOT NULL DEFAULT '' CHECK(length(details)<=300),
  status TEXT NOT NULL CHECK(status IN ('review','published','disabled','rejected','cancelled')),
  origin TEXT NOT NULL CHECK(origin IN ('manual','automation')),
  manual_locked INTEGER NOT NULL DEFAULT 0 CHECK(manual_locked IN (0,1)),
  date_basis TEXT NOT NULL CHECK(date_basis IN ('printed-date','printed-weekday','relative','publication-date','manual')),
  -- No foreign key: import history is pruned after 30 days. evidence_json keeps provenance.
  source_post_id TEXT,
  source_import_id TEXT,
  source_created_time TEXT,
  source_permalink TEXT NOT NULL DEFAULT '',
  fingerprint TEXT,
  identity TEXT,
  evidence_json TEXT,
  -- Values automation last wrote: automation may update only while unchanged.
  last_auto_json TEXT,
  review_reason TEXT NOT NULL DEFAULT '' CHECK(length(review_reason)<=600),
  revision INTEGER NOT NULL DEFAULT 0,
  -- Staff saves fence dependent offer writes on their own token.
  mutation_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(end_time IS NULL OR start_time IS NULL OR end_time > start_time),
  -- A staff-created event may link the Facebook post staff identified.
  CHECK(source_post_id IS NULL OR origin='automation' OR manual_locked=1)
);
CREATE UNIQUE INDEX special_events_source ON special_events(source_post_id) WHERE source_post_id IS NOT NULL;
CREATE INDEX special_events_date ON special_events(event_date, status);
CREATE TABLE special_event_offers (
  event_id TEXT NOT NULL REFERENCES special_events(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 4),
  -- Price inline, same 150-character rule as weekly specials.
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 150),
  PRIMARY KEY(event_id, position)
);
-- Event audit trail, separate from special_import_events so event decisions
-- never disturb the daily publisher's audit de-duplication.
CREATE TABLE special_event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT,
  source_post_id TEXT,
  action TEXT NOT NULL CHECK(action IN ('created','updated','duplicate','protected','conflict','cancelled','cancellation-review')),
  detail TEXT NOT NULL DEFAULT '' CHECK(length(detail)<=1000),
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX special_event_log_source ON special_event_log(source_post_id, id);
