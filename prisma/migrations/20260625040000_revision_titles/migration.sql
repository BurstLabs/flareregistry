-- Version the title alongside the body so the public edit history reflects title changes too.
ALTER TABLE "ProviderFlagGroundsRevision" ADD COLUMN "title" TEXT;
ALTER TABLE "ProviderFlagGroundsEntryRevision" ADD COLUMN "title" TEXT;
ALTER TABLE "ProviderFlagDefenseRevision" ADD COLUMN "title" TEXT;
ALTER TABLE "ProviderFlagDefenseEntryRevision" ADD COLUMN "title" TEXT;

-- Backfill existing revisions with their parent entry's current title (best available value; older
-- revisions predate titles, so this just stamps the latest known title onto historical rows).
UPDATE "ProviderFlagGroundsRevision" r
  SET "title" = i."title"
  FROM "ProviderFlagInitiation" i
  WHERE r."initiationId" = i."id" AND i."title" IS NOT NULL;

UPDATE "ProviderFlagGroundsEntryRevision" r
  SET "title" = e."title"
  FROM "ProviderFlagGroundsEntry" e
  WHERE r."entryId" = e."id" AND e."title" IS NOT NULL;

UPDATE "ProviderFlagDefenseRevision" r
  SET "title" = d."title"
  FROM "ProviderFlagDefense" d
  WHERE r."defenseId" = d."id" AND d."title" IS NOT NULL;

UPDATE "ProviderFlagDefenseEntryRevision" r
  SET "title" = e."title"
  FROM "ProviderFlagDefenseEntry" e
  WHERE r."entryId" = e."id" AND e."title" IS NOT NULL;
