-- Conduct cases share ProviderFlagCase with new-provider flags but are sealed until published.
-- Existing rows are all new-provider flags, and those are public by design, so the default of
-- 'FLAG' preserves current behaviour exactly with no backfill and nothing to miss.
ALTER TABLE "ProviderFlagCase" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'FLAG';
ALTER TABLE "ProviderFlagCase" ADD COLUMN "publishedAt" TIMESTAMP(3);
CREATE INDEX "ProviderFlagCase_kind_publishedAt_idx" ON "ProviderFlagCase"("kind", "publishedAt");
