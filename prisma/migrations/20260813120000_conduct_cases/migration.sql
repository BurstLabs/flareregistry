-- Conduct case fields.
ALTER TABLE "ProviderFlagCase" ADD COLUMN "noticeEndsAt" TIMESTAMP(3);
ALTER TABLE "ProviderFlagCase" ADD COLUMN "serviceStatus" TEXT;
ALTER TABLE "ProviderFlagCase" ADD COLUMN "lateReplyAt" TIMESTAMP(3);

-- A case record must survive deletion of its subject. Cascade made provider deletion an undo
-- button for an adjudicated finding.
ALTER TABLE "ProviderFlagCase" DROP CONSTRAINT "ProviderFlagCase_providerId_fkey";
ALTER TABLE "ProviderFlagCase" ADD CONSTRAINT "ProviderFlagCase_providerId_fkey"
  FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ProviderFlagEvidence" (
    "id" TEXT NOT NULL,
    "initiationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "chain" TEXT,
    "ref" TEXT NOT NULL,
    "claim" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderFlagEvidence_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProviderFlagEvidence_initiationId_idx" ON "ProviderFlagEvidence"("initiationId");
ALTER TABLE "ProviderFlagEvidence" ADD CONSTRAINT "ProviderFlagEvidence_initiationId_fkey"
  FOREIGN KEY ("initiationId") REFERENCES "ProviderFlagInitiation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ProviderCaseAudit" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderCaseAudit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ProviderCaseAudit_caseId_createdAt_idx" ON "ProviderCaseAudit"("caseId", "createdAt");
