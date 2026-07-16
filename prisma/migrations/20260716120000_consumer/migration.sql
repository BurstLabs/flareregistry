-- Consumer: a third-party product that USES the Flare Registry feed, showcased on /powered-by.
-- Wallet-less and moderated: submissions (new or edit proposals) are held until an admin approves.
CREATE TABLE "Consumer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "blurb" TEXT NOT NULL,
    "logoURL" TEXT,
    "contactEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "pendingChanges" JSONB,
    "pendingKind" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    CONSTRAINT "Consumer_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Consumer_status_idx" ON "Consumer"("status");
