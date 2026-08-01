-- The USDC on-grid tolerance is now DERIVED from the encoder's quantisation bound rather than fixed, so
-- the expected hit rate under the null varies per observation. Accumulate it so the API can normalise
-- against the real chance rate instead of assuming a constant.
ALTER TABLE "ProviderSimilarity" ADD COLUMN "usdcChanceSum" DOUBLE PRECISION NOT NULL DEFAULT 0;
