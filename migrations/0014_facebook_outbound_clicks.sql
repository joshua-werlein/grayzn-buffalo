-- Dedicated anonymous daily totals. No individual click records or identifiers.
CREATE TABLE IF NOT EXISTS facebook_outbound_clicks_daily (
  date TEXT PRIMARY KEY CHECK (date GLOB '????-??-??'),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0)
);
-- Set facebook_click_tracking_started in settings to the actual Chicago rollout
-- date when enabling production tracking; do not infer coverage from the first click.
