-- Management Group eligibility, computed by scripts/ingest-mg-eligibility.mjs against
-- PollingManagementGroup on Flare mainnet. All nullable: Songbird rows never carry these, and a
-- provider that has not been evaluated yet must be distinguishable from one evaluated as ineligible.
ALTER TABLE "ProviderOnchain"
  ADD COLUMN "mgEligible"         BOOLEAN,
  ADD COLUMN "mgVerdict"          TEXT,
  ADD COLUMN "mgBlockReason"      TEXT,
  ADD COLUMN "mgRewardedStreak"   INTEGER,
  ADD COLUMN "mgEpochsRemaining"  INTEGER,
  ADD COLUMN "mgBlockedAtEpoch"   INTEGER,
  ADD COLUMN "mgMemberSinceEpoch" INTEGER,
  ADD COLUMN "mgCheckedEpoch"     INTEGER,
  ADD COLUMN "mgCheckedAt"        TIMESTAMP(3);
