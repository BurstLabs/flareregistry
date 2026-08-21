-- When the ingest last RAN, as distinct from when it last found something. updatedAt only moves
-- when lastEpochIngested changes, which is every 3.5 days, so it cannot answer "how current is this
-- figure". Backfilled from updatedAt, which is the best estimate available for existing rows.
ALTER TABLE "IngestState" ADD COLUMN "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "IngestState" SET "checkedAt" = "updatedAt";
