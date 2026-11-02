-- Per-epoch P-chain stake on each provider's validator nodes (sum of nodeWeights from
-- reward-epoch-info.json), so the yield feed can say what stakers earned per staked FLR next to what
-- delegators earned per wrapped FLR. Additive: a new nullable column, no existing column changes.
-- Text, like the other weights: wei-scale values summed in BigInt, never in SQL.
--
-- Existing rows stay NULL here. scripts/ingest-fsp-rewards.mjs fills the recent ones from the same
-- published files on its next run, and new epochs carry the value from the start.
ALTER TABLE "ProviderMetricEpoch" ADD COLUMN IF NOT EXISTS "stakeWeight" TEXT;
