-- Supplemental grounds entries: the flagging member can add extra dated entries (each with its own
-- edit history) beyond their primary flag. Informational only; does not affect co-initiation.
CREATE TABLE "ProviderFlagGroundsEntry" (
  "id" TEXT NOT NULL,
  "initiationId" TEXT NOT NULL,
  "grounds" TEXT NOT NULL,
  "signerAddress" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "editedAt" TIMESTAMP(3),
  CONSTRAINT "ProviderFlagGroundsEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProviderFlagGroundsEntry_initiationId_idx" ON "ProviderFlagGroundsEntry"("initiationId");

ALTER TABLE "ProviderFlagGroundsEntry"
  ADD CONSTRAINT "ProviderFlagGroundsEntry_initiationId_fkey"
  FOREIGN KEY ("initiationId") REFERENCES "ProviderFlagInitiation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderFlagGroundsEntryRevision" (
  "id" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "grounds" TEXT NOT NULL,
  "signerAddress" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderFlagGroundsEntryRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProviderFlagGroundsEntryRevision_entryId_idx" ON "ProviderFlagGroundsEntryRevision"("entryId");

ALTER TABLE "ProviderFlagGroundsEntryRevision"
  ADD CONSTRAINT "ProviderFlagGroundsEntryRevision_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "ProviderFlagGroundsEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
