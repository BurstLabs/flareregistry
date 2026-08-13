-- The score ages a finding in reward epochs, so the decision epoch is stored rather than
-- derived from the timestamp after the fact.
ALTER TABLE "ProviderFlagCase" ADD COLUMN "decidedEpoch" INTEGER;
