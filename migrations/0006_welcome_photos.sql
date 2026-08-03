-- Four fixed Welcome-section photo slots. Each row points to the full-size
-- R2 object; the @600 thumbnail key is derived in code, just like menu items.
CREATE TABLE IF NOT EXISTS welcome_photos (
  slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 4),
  photo_key TEXT,
  alt TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT ''
);

INSERT INTO welcome_photos (slot) VALUES (1), (2), (3), (4)
ON CONFLICT(slot) DO NOTHING;
