-- Evidence images attached to a governance point (a member's grounds or the provider's response).
-- Files live on local disk; this table holds the metadata + which point each image belongs to.
CREATE TABLE "ProviderFlagPointImage" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "initiationId" TEXT,
    "groundsEntryId" TEXT,
    "defenseId" TEXT,
    "defenseEntryId" TEXT,
    "mime" TEXT NOT NULL,
    "ext" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "signerAddress" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderFlagPointImage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProviderFlagPointImage_caseId_idx" ON "ProviderFlagPointImage"("caseId");
CREATE INDEX "ProviderFlagPointImage_initiationId_idx" ON "ProviderFlagPointImage"("initiationId");
CREATE INDEX "ProviderFlagPointImage_groundsEntryId_idx" ON "ProviderFlagPointImage"("groundsEntryId");
CREATE INDEX "ProviderFlagPointImage_defenseId_idx" ON "ProviderFlagPointImage"("defenseId");
CREATE INDEX "ProviderFlagPointImage_defenseEntryId_idx" ON "ProviderFlagPointImage"("defenseEntryId");

ALTER TABLE "ProviderFlagPointImage"
    ADD CONSTRAINT "ProviderFlagPointImage_caseId_fkey"
    FOREIGN KEY ("caseId") REFERENCES "ProviderFlagCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
