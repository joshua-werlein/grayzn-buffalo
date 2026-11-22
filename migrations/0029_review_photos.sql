CREATE TABLE review_photos (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('food', 'drinks', 'bar')),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 180),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  revision INTEGER NOT NULL DEFAULT 0,
  small_width INTEGER NOT NULL CHECK (small_width BETWEEN 1 AND 320),
  medium_width INTEGER NOT NULL CHECK (medium_width BETWEEN 1 AND 640),
  medium_height INTEGER NOT NULL CHECK (medium_height BETWEEN 1 AND 640),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX review_photos_active_digest ON review_photos(digest)
  WHERE status IN ('pending', 'approved');
CREATE INDEX review_photos_gallery ON review_photos(status, updated_at DESC, id DESC);

CREATE TABLE review_menu_photos (
  item_id INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  photo_id TEXT NOT NULL REFERENCES review_photos(id),
  revision TEXT NOT NULL
);

CREATE INDEX review_menu_photos_photo ON review_menu_photos(photo_id);

-- Revoke associations in the same statement that withdraws approval or moves
-- a photo out of Food. This also covers writes outside the moderation UI.
CREATE TRIGGER review_menu_photo_revoke
AFTER UPDATE OF status, category ON review_photos
WHEN NEW.status <> 'approved' OR NEW.category <> 'food'
BEGIN
  DELETE FROM review_menu_photos WHERE photo_id = NEW.id;
END;

-- Staff can still replace an existing image through the original upload flow.
CREATE TRIGGER review_menu_staff_photo_changed
AFTER UPDATE OF photo_key, active ON items
WHEN NEW.photo_key IS NOT OLD.photo_key OR NEW.active <> 1
BEGIN
  DELETE FROM review_menu_photos WHERE item_id = NEW.id;
END;
