-- Late Night is a per-item FLAG, not a category.
-- Per-item control over what's available after the grill closes.
--   npx wrangler d1 execute grayzn-db --remote --file=./migrations/0003_late_night.sql
--
-- NOTE: VS Code's MSSQL extension will flag "Incorrect syntax near 'COLUMN'".
-- That is the wrong dialect — this is valid SQLite/D1. Ignore it.
ALTER TABLE items ADD COLUMN late_night INTEGER NOT NULL DEFAULT 0;
 