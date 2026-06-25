-- Multi-entry, editable provider response with public revision history (mirrors flag grounds).
ALTER TABLE "ProviderFlagDefense" ADD COLUMN "editedAt" TIMESTAMP(3);

CREATE TABLE "ProviderFlagDefenseRevision" (
  "id" TEXT NOT NULL,
  "defenseId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderFlagDefenseRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProviderFlagDefenseRevision_defenseId_idx" ON "ProviderFlagDefenseRevision"("defenseId");
ALTER TABLE "ProviderFlagDefenseRevision"
  ADD CONSTRAINT "ProviderFlagDefenseRevision_defenseId_fkey"
  FOREIGN KEY ("defenseId") REFERENCES "ProviderFlagDefense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderFlagDefenseEntry" (
  "id" TEXT NOT NULL,
  "defenseId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editedAt" TIMESTAMP(3),
  CONSTRAINT "ProviderFlagDefenseEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProviderFlagDefenseEntry_defenseId_idx" ON "ProviderFlagDefenseEntry"("defenseId");
ALTER TABLE "ProviderFlagDefenseEntry"
  ADD CONSTRAINT "ProviderFlagDefenseEntry_defenseId_fkey"
  FOREIGN KEY ("defenseId") REFERENCES "ProviderFlagDefense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderFlagDefenseEntryRevision" (
  "id" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderFlagDefenseEntryRevision_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProviderFlagDefenseEntryRevision_entryId_idx" ON "ProviderFlagDefenseEntryRevision"("entryId");
ALTER TABLE "ProviderFlagDefenseEntryRevision"
  ADD CONSTRAINT "ProviderFlagDefenseEntryRevision_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "ProviderFlagDefenseEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the original text of every existing defense as its first revision, so history is complete.
INSERT INTO "ProviderFlagDefenseRevision" ("id", "defenseId", "body", "createdAt")
SELECT gen_random_uuid()::text, "id", "body", "createdAt"
FROM "ProviderFlagDefense";
