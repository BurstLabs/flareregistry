-- USDC config signature. The example provider prices USDC/USD from USDC/USDT books times its OWN
-- USDT/USD median; USDC/USDT ticks at 1e-4, so USDC_USD / USDT_USD must sit on a 1e-4 grid for anyone
-- running the shipped config. Needs only the provider's own two submitted values.
ALTER TABLE "ProviderSimilarity" ADD COLUMN "usdcGridHits" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ProviderSimilarity" ADD COLUMN "usdcGridN" INTEGER NOT NULL DEFAULT 0;
-- Pearson sums over (USDC, USDT) for the correlation gate that catches example code running a
-- different USDC book (a measured false-custom class).
ALTER TABLE "ProviderSimilarity" ADD COLUMN "usdcSumX" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "ProviderSimilarity" ADD COLUMN "usdcSumY" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "ProviderSimilarity" ADD COLUMN "usdcSumXY" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "ProviderSimilarity" ADD COLUMN "usdcSumXX" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "ProviderSimilarity" ADD COLUMN "usdcSumYY" DOUBLE PRECISION NOT NULL DEFAULT 0;
