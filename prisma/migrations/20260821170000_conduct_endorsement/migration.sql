-- A CONDUCT co-initiator may sign the case as it stands instead of authoring a separate ground.
-- Existing rows all carry authored grounds, so the default is correct for every one of them.
ALTER TABLE "ProviderFlagInitiation" ADD COLUMN "endorsement" BOOLEAN NOT NULL DEFAULT false;
