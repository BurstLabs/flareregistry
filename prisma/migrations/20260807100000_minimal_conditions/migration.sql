-- Minimal conditions, from passes.json in the epoch folder the ingest already walks.
--
-- goodStanding was hardcoded true by both ingest paths, so the registry reported every provider as in
-- good standing during epochs where Flare had burned all of their rewards (12 of 98 in epoch 420).
-- It becomes nullable because "no file for this epoch" is not the same as "passed", and the two must
-- not render identically. Existing rows are reset to NULL rather than left at their hardcoded true:
-- an unverified value that happens to be right is still unverified, and the re-ingest repopulates it.
ALTER TABLE "ProviderMetricEpoch" ALTER COLUMN "goodStanding" DROP DEFAULT;
ALTER TABLE "ProviderMetricEpoch" ALTER COLUMN "goodStanding" DROP NOT NULL;
UPDATE "ProviderMetricEpoch" SET "goodStanding" = NULL;

ALTER TABLE "ProviderMetricEpoch" ADD COLUMN "passes" INTEGER;
ALTER TABLE "ProviderMetricEpoch" ADD COLUMN "failures" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "ProviderOnchain" ALTER COLUMN "goodStanding" DROP DEFAULT;
ALTER TABLE "ProviderOnchain" ALTER COLUMN "goodStanding" DROP NOT NULL;
UPDATE "ProviderOnchain" SET "goodStanding" = NULL;
