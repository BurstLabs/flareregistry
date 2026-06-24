-- Governance flag mechanism (docs/governance-flag-mechanism.md).
ALTER TABLE "Provider" ADD COLUMN "flaggedOnce" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Provider" ADD COLUMN "suspended" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ProviderFlagCase" (
  "id" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "network" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "discussionEndsAt" TIMESTAMP(3) NOT NULL,
  "votingEndsAt" TIMESTAMP(3) NOT NULL,
  "decidedAt" TIMESTAMP(3),
  "isReVote" BOOLEAN NOT NULL DEFAULT false,
  "memberCountAtOpen" INTEGER NOT NULL,
  "outcomeTurnout" INTEGER,
  "outcomeDeny" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ProviderFlagCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderFlagInitiation" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "memberEntityVoter" TEXT NOT NULL,
  "signerAddress" TEXT NOT NULL,
  "grounds" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderFlagInitiation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderFlagVote" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "memberEntityVoter" TEXT NOT NULL,
  "signerAddress" TEXT NOT NULL,
  "vote" TEXT NOT NULL,
  "comment" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderFlagVote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderFlagDefense" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderFlagDefense_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderFlagInitiation_caseId_memberEntityVoter_key" ON "ProviderFlagInitiation"("caseId", "memberEntityVoter");
CREATE UNIQUE INDEX "ProviderFlagVote_caseId_memberEntityVoter_key" ON "ProviderFlagVote"("caseId", "memberEntityVoter");
CREATE UNIQUE INDEX "ProviderFlagDefense_caseId_key" ON "ProviderFlagDefense"("caseId");

ALTER TABLE "ProviderFlagCase" ADD CONSTRAINT "ProviderFlagCase_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderFlagInitiation" ADD CONSTRAINT "ProviderFlagInitiation_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ProviderFlagCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderFlagVote" ADD CONSTRAINT "ProviderFlagVote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ProviderFlagCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderFlagDefense" ADD CONSTRAINT "ProviderFlagDefense_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "ProviderFlagCase"("id") ON DELETE CASCADE ON UPDATE CASCADE;
