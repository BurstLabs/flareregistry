-- A permanent record of every logo decision.
--
-- Approving or rejecting a pending logo clears every logoPending* column on Provider, so the act
-- previously left no trace: no record of who published an image to a public feed, when, or what it
-- replaced. providerName/logoURI/previousURI are snapshots rather than relations so the record
-- outlives a rename, an archive, or a deletion of its subject.
CREATE TABLE "LogoDecision" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerName" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "logoURI" TEXT,
    "previousURI" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "uploadedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogoDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LogoDecision_createdAt_idx" ON "LogoDecision"("createdAt");
CREATE INDEX "LogoDecision_providerId_idx" ON "LogoDecision"("providerId");
