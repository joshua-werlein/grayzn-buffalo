-- LOCAL PREPARATION ONLY. Production application requires separate approval,
-- after 0025 is applied and a fresh backup is verified.
-- Additive: one nullable column; no existing row, constraint or index changes.
-- Plain ALTER so an accidental replay fails loudly ("duplicate column name").
-- display_from is when customers may first SEE an event advertised (a Chicago
-- calendar date). It never changes when the offer is valid: event_date with
-- start_time/end_time stays the availability window. NULL shows the event as
-- soon as it is published. Site code works with or without this column.
ALTER TABLE special_events ADD COLUMN display_from TEXT
  CHECK(display_from IS NULL OR display_from GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
