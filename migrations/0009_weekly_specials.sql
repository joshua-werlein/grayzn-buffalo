-- Date-ranged weekly specials. The legacy fixed-weekday table remains intact;
-- each saved week gets structured Sunday-through-Saturday service fields.
CREATE TABLE weekly_specials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start_date TEXT NOT NULL,
  week_end_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (week_start_date GLOB '????-??-??'),
  CHECK (week_end_date GLOB '????-??-??'),
  CHECK (week_start_date <= week_end_date),
  UNIQUE (week_start_date, week_end_date)
);

CREATE INDEX weekly_specials_range_idx ON weekly_specials (week_start_date, week_end_date);

CREATE TABLE weekly_special_days (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  weekly_special_id INTEGER NOT NULL REFERENCES weekly_specials(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  lunch_content TEXT NOT NULL DEFAULT '',
  nightly_content TEXT NOT NULL DEFAULT '',
  allday_content TEXT NOT NULL DEFAULT '',
  UNIQUE (weekly_special_id, day_of_week)
);
