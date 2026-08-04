-- The recently-removed gate is a 7-day timer rather than an epoch count, and a departing member
-- usually still holds a full reward streak, so its epoch countdown is legitimately 0. Storing that 0
-- alone would render as "eligible now" while the contract keeps refusing.
ALTER TABLE "ProviderOnchain" ADD COLUMN "mgBlockedUntil" TIMESTAMP(3);
