-- Split validator stake into its two legs and make `weight` the TOTAL, matching the documented API.
-- `weight` previously held the P-chain's self-bond-only value. Backfill selfBond from it so no data is
-- lost; the next ingest recomputes weight as selfBond + delegatedWeight.
ALTER TABLE "ProviderValidator" ADD COLUMN IF NOT EXISTS "selfBond" TEXT;
ALTER TABLE "ProviderValidator" ADD COLUMN IF NOT EXISTS "delegatedWeight" TEXT;
UPDATE "ProviderValidator" SET "selfBond" = "weight" WHERE "selfBond" IS NULL;
