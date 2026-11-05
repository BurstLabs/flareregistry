-- A registration with no participation, so a named entity that Flare's explorer carries can be
-- published by us instead of falling back to an archived provider list for its name.
ALTER TABLE "ProviderAddress" ADD COLUMN "entityRegistered" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProviderAddress" ADD COLUMN "entityCheckedAt" TIMESTAMP(3);
