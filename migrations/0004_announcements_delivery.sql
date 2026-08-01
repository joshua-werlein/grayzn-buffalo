-- Replace the former single announcement setting with three independent slots.
-- Preserve any existing announcement by moving it into the first slot without
-- overwriting a value staff may already have saved there.
INSERT INTO settings (key, value)
SELECT 'announcement_1', value FROM settings WHERE key = 'announcement'
ON CONFLICT(key) DO NOTHING;

INSERT INTO settings (key, value) VALUES
 ('announcement_1', ''),
 ('announcement_2', ''),
 ('announcement_3', ''),
 ('delivery_paused', '0')
ON CONFLICT(key) DO NOTHING;
