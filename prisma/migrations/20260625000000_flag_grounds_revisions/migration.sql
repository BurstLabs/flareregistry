-- Editable flag grounds with a public, append-only revision history.
ALTER TABLE "ProviderFlagInitiation" ADD COLUMN "editedAt" TIMESTAMP(3);

CREATE TABLE "ProviderFlagGroundsRevision" (
  "id" TEXT NOT NULL,
  "initiationId" TEXT NOT NULL,
  "grounds" TEXT NOT NULL,
  "signerAddress" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderFlagGroundsRevision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProviderFlagGroundsRevision_initiationId_idx" ON "ProviderFlagGroundsRevision"("initiationId");

ALTER TABLE "ProviderFlagGroundsRevision"
  ADD CONSTRAINT "ProviderFlagGroundsRevision_initiationId_fkey"
  FOREIGN KEY ("initiationId") REFERENCES "ProviderFlagInitiation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed the original text of every existing flag as its first revision, so history is complete
-- from the start (the original is stamped with the initiation's own createdAt + signer).
INSERT INTO "ProviderFlagGroundsRevision" ("id", "initiationId", "grounds", "signerAddress", "createdAt")
SELECT gen_random_uuid()::text, "id", "grounds", "signerAddress", "createdAt"
FROM "ProviderFlagInitiation";
