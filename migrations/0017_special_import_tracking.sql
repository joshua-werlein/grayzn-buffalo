-- Apply with d1 execute only, during the documented application cutover.
-- Tracks Facebook post specials candidates through fetch, AI extraction, and staff review.
-- D1 rows are kept for audit history after R2 evidence images are cleaned up at 30 days.

CREATE TABLE special_imports (
  -- Deterministic source-version id: first 32 hex chars of SHA-256 of
  -- fb_post_id + ':' + caption_hash + ':' + image_source_version + ':' +
  -- parser_version + ':' + model_id.  INSERT OR IGNORE makes cron idempotent.
  id TEXT PRIMARY KEY,
  fb_post_id TEXT NOT NULL,
  fb_created_time TEXT NOT NULL,
  fb_updated_time TEXT,
  caption TEXT NOT NULL DEFAULT '',
  permalink_url TEXT NOT NULL DEFAULT '',
  -- First 16 hex chars of SHA-256 of the caption bytes.
  caption_hash TEXT NOT NULL DEFAULT '',
  -- Same value as the existing imageSourceVersion() function in worker.js.
  image_source_version TEXT NOT NULL DEFAULT '',
  -- R2 key under special-imports/ prefix (null if no image or download failed).
  image_r2_key TEXT,
  -- First 16 hex chars of SHA-256 of the raw image bytes (null if unavailable).
  image_hash TEXT,
  -- Increment IMPORT_PARSER_VERSION in worker.js when classification logic changes.
  parser_version INTEGER NOT NULL DEFAULT 1,
  -- Workers AI model id string used for extraction.
  model_id TEXT NOT NULL DEFAULT '',
  -- Deterministic classification from caption text (before AI).
  target_kind TEXT CHECK(target_kind IN ('week','section','ambiguous','ignored')),
  -- 0-6 for Sunday-Saturday, null for weekly/all-day candidates.
  target_day INTEGER CHECK(target_day BETWEEN -1 AND 6),
  -- 'lunch' or 'nightly'; null when service is ambiguous.
  target_service TEXT,
  -- For section kind: the collection id (e.g. 'mexican-night').
  target_collection_id TEXT,
  classification_reason TEXT NOT NULL DEFAULT '',
  -- Raw JSON string returned by AI (preserved verbatim; may be malformed).
  extracted_json TEXT,
  -- Validated, normalized CandidateGroup array ready for staff review.
  -- null when validation failed or AI was skipped.
  candidate_json TEXT,
  validation_result TEXT CHECK(validation_result IN ('ok','rejected')),
  validation_reason TEXT NOT NULL DEFAULT '',
  -- Processing lifecycle managed by the Worker.
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(processing_status IN ('pending','processing','staged','failed','skipped')),
  -- Review lifecycle managed by staff through the admin UI.
  review_status TEXT NOT NULL DEFAULT 'pending'
    CHECK(review_status IN ('pending','accepted','edited','kept','dismissed')),
  review_reason TEXT NOT NULL DEFAULT '',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Set when AI extraction runs (used for daily inference count).
  processed_at TEXT,
  reviewed_at TEXT
);

CREATE INDEX special_imports_review ON special_imports(review_status, processing_status, fetched_at);
CREATE INDEX special_imports_post ON special_imports(fb_post_id, fb_created_time);

-- Lightweight audit trail for review actions and processing events.
-- Rows here survive longer than the R2 images.
CREATE TABLE special_import_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id TEXT NOT NULL REFERENCES special_imports(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK(event_type IN ('fetch','classify','extract','validate','stage','review','retry','error')),
  detail TEXT NOT NULL DEFAULT '',
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX special_import_events_import ON special_import_events(import_id, occurred_at);
