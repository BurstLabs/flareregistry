-- Per-entry freshness, so a consumer reconciling this feed against another provider list can ask
-- when our copy last changed and when its owner last signed for it, instead of resolving a
-- disagreement by list precedence.
ALTER TABLE "ProviderAddress" ADD COLUMN "attestedAt" TIMESTAMP(3);
ALTER TABLE "ProviderAddress" ADD COLUMN "contentHash" TEXT;
ALTER TABLE "ProviderAddress" ADD COLUMN "contentUpdatedAt" TIMESTAMP(3);

-- attestedAt is backfilled EXACTLY, not approximated. Until this migration, verifiedAt was
-- overwritten on every authenticated save, so the value sitting in it is already "the last time
-- this address proved control", which is what attestedAt means. From here the two diverge:
-- verifiedAt stops moving and attestedAt keeps up.
UPDATE "ProviderAddress" SET "attestedAt" = "verifiedAt" WHERE "verifiedAt" IS NOT NULL;

-- contentUpdatedAt is left null for the backfill script to fill from the committed feed's git
-- history, which records every published change since 2026-06-24 and can therefore date each entry
-- exactly rather than guessing from a row stamp.
