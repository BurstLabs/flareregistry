ALTER TABLE "ProviderSimilarity" ADD COLUMN "feedErrorsJson" JSONB;
ALTER TABLE "ProviderSimilarity" ADD COLUMN "errorProfileN" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "DetectionCursor" ADD COLUMN "refFeedErrorsJson" JSONB;
