-- Orientation is derived from the already EXIF-corrected client-side pixels.
-- Menu orientation also lets its fixed Welcome fallbacks use the right tile.
ALTER TABLE items ADD COLUMN photo_orientation TEXT NOT NULL DEFAULT 'portrait'
  CHECK (photo_orientation IN ('portrait', 'square', 'landscape'));

ALTER TABLE welcome_photos ADD COLUMN orientation TEXT NOT NULL DEFAULT 'portrait'
  CHECK (orientation IN ('portrait', 'square', 'landscape'));
