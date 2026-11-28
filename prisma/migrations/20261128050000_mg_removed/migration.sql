-- When an entity was last removed from the Management Group and on what ground, so a removed provider's
-- page can say so, and the first reward epoch at which a recent chill stops blocking a rejoin.
ALTER TABLE "ProviderOnchain" ADD COLUMN "mgRemovedAt" TIMESTAMP(3);
ALTER TABLE "ProviderOnchain" ADD COLUMN "mgRemovedReason" TEXT;
ALTER TABLE "ProviderOnchain" ADD COLUMN "mgChillClearEpoch" INTEGER;
