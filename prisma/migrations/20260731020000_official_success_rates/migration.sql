-- Official provider success rates from Flare's systems-explorer entity API, stored verbatim in basis
-- points out of 10000 (divide by 100 for a percentage) so we never re-derive Flare's own metric.
ALTER TABLE "ProviderOnchain" ADD COLUMN "successPrimary" INTEGER;
ALTER TABLE "ProviderOnchain" ADD COLUMN "successSecondary" INTEGER;
ALTER TABLE "ProviderOnchain" ADD COLUMN "successAvailability" INTEGER;
ALTER TABLE "ProviderOnchain" ADD COLUMN "successEpoch" INTEGER;
ALTER TABLE "ProviderOnchain" ADD COLUMN "successUpdatedAt" TIMESTAMP(3);
