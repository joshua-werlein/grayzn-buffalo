-- Replaces the binary pause switch while preserving existing "1" values as unavailable.
INSERT INTO settings (key, value)
SELECT 'delivery_display', CASE value WHEN '1' THEN 'unavailable' ELSE 'available' END
FROM settings WHERE key = 'delivery_paused'
ON CONFLICT(key) DO NOTHING;
