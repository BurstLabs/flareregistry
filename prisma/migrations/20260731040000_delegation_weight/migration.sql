-- Current-epoch weights from Flare's systems-explorer entity record. delegationWeight is what that
-- explorer labels "DELEGATION WEIGHT". Kept separate from wNatWeight, which comes from the fsp-rewards
-- ingest and lags by reward epochs.
ALTER TABLE "ProviderOnchain" ADD COLUMN "delegationWeight" TEXT;
ALTER TABLE "ProviderOnchain" ADD COLUMN "delegationWeightCapped" TEXT;
ALTER TABLE "ProviderOnchain" ADD COLUMN "stakingWeight" TEXT;
