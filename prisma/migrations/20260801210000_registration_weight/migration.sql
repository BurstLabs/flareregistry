-- FIP.16 registration weight, stored verbatim from VoterRegistry.getVoterRegistrationWeight.
-- Text, not numeric: the value is wei^0.75 and exceeds any fixed-precision numeric we would want to
-- pick, and it is only ever used as a ratio, never summed in SQL.
ALTER TABLE "ProviderOnchain" ADD COLUMN IF NOT EXISTS "registrationWeight" TEXT;
ALTER TABLE "ProviderOnchain" ADD COLUMN IF NOT EXISTS "registrationEpoch" INTEGER;
