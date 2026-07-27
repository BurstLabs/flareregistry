ALTER TABLE "ProviderSimilarity" ADD COLUMN "bestVariant" TEXT;
-- DetectionCalibration.id becomes the variant key; existing 'flare' row is stale under the new model.
DELETE FROM "DetectionCalibration";
ALTER TABLE "DetectionCalibration" ALTER COLUMN "id" DROP DEFAULT;
