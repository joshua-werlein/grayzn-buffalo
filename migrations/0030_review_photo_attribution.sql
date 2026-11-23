-- Existing photos remain Anonymous until staff supplies a display name.
ALTER TABLE review_photos ADD COLUMN display_name TEXT
  CHECK (display_name IS NULL OR length(trim(display_name)) BETWEEN 1 AND 60);

CREATE INDEX review_photos_category_gallery
  ON review_photos(status, category, updated_at DESC, id DESC);
