-- Apply before deploying the recovery Worker. No specials or review decisions change.
ALTER TABLE special_imports ADD COLUMN attempt_token TEXT;
ALTER TABLE special_imports ADD COLUMN lease_expires_at TEXT;
ALTER TABLE special_imports ADD COLUMN next_attempt_at TEXT;
ALTER TABLE special_imports ADD COLUMN failure_kind TEXT
  CHECK(failure_kind IN ('transient_ai','transient_image','transient_storage','permanent','budget','exhausted','expired'));

-- retry_count now counts started processing attempts, including the initial attempt.
-- Historical failed/skipped evidence is deliberately NOT automatically requeued.
UPDATE special_imports SET retry_count=MAX(retry_count,1)
WHERE processing_status<>'pending';
-- Older Workers have no fencing token. Drain them before enabling recovery.
-- Give legacy interrupted claims an explicit lease and earliest recovery time.
UPDATE special_imports SET attempt_token='legacy:'||id,
  lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',fetched_at,'+20 minutes'),
  next_attempt_at=strftime('%Y-%m-%dT%H:%M:%fZ',fetched_at,'+30 minutes')
WHERE processing_status='processing';
CREATE INDEX special_imports_recovery ON special_imports(processing_status,review_status,next_attempt_at);
