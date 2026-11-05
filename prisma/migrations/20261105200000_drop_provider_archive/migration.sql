-- Departure becomes derived rather than stored.
--
-- A provider that stops submitting is no longer removed from the feed: it keeps its entry with
-- listed:false and flareregistry.status "departed", computed each build from the same
-- PURGE_AFTER_EPOCHS threshold this flag used to be written on. Nothing reads these columns any
-- more, and leaving them would leave a second, unmaintained answer to a question the feed already
-- answers.
--
-- No data is lost that cannot be recomputed: archivedAt was the date a cron first judged a
-- provider silent, and the same judgement is re-derived from on-chain data on every feed build.
DROP INDEX IF EXISTS "Provider_archivedAt_idx";
ALTER TABLE "Provider" DROP COLUMN IF EXISTS "archivedAt";
ALTER TABLE "Provider" DROP COLUMN IF EXISTS "archivedReason";
