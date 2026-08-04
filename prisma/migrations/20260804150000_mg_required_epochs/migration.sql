-- addAfterRewardedEpochs is governance-settable. The provider page renders "N of M consecutive
-- epochs", so M is recorded at check time rather than hardcoded in the UI, where a governance vote
-- would silently turn it into a wrong number.
ALTER TABLE "ProviderOnchain" ADD COLUMN "mgRequiredEpochs" INTEGER;
