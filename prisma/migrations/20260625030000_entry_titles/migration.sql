-- Optional one-line subject/title per grounds and response entry (falls back to "Point N" in UI).
ALTER TABLE "ProviderFlagInitiation" ADD COLUMN "title" TEXT;
ALTER TABLE "ProviderFlagGroundsEntry" ADD COLUMN "title" TEXT;
ALTER TABLE "ProviderFlagDefense" ADD COLUMN "title" TEXT;
ALTER TABLE "ProviderFlagDefenseEntry" ADD COLUMN "title" TEXT;
