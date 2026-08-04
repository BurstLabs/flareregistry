-- Wall-clock dates for the Management Group countdown, so "20 reward epochs" also reads as a date.
-- Derived from the chain's timing getters, not from arithmetic on a hardcoded genesis timestamp.
ALTER TABLE "ProviderOnchain"
  ADD COLUMN "mgEligibleEstimatedAt" TIMESTAMP(3),
  ADD COLUMN "mgBlockedAtEpochTs"    TIMESTAMP(3);
