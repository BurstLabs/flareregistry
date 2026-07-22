-- CreateTable
CREATE TABLE "ImportCandidate" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'towolabs',
    "chainId" INTEGER NOT NULL,
    "address" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "logoURI" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,

    CONSTRAINT "ImportCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ImportCandidate_chainId_address_key" ON "ImportCandidate"("chainId", "address");

-- CreateIndex
CREATE INDEX "ImportCandidate_status_idx" ON "ImportCandidate"("status");
