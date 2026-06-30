-- Pending-logo review window (7 days) + Management-Group logo reports (history retained).
ALTER TABLE "Provider" ADD COLUMN "logoPendingURI" TEXT;
ALTER TABLE "Provider" ADD COLUMN "logoPendingAt" TIMESTAMP(3);
ALTER TABLE "Provider" ADD COLUMN "logoPendingSigner" TEXT;
CREATE INDEX "Provider_logoPendingAt_idx" ON "Provider"("logoPendingAt");

CREATE TABLE "LogoReport" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "logoURI" TEXT,
    "reporterAddress" TEXT NOT NULL,
    "reporterVoter" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LogoReport_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "LogoReport_providerId_idx" ON "LogoReport"("providerId");
CREATE INDEX "LogoReport_status_idx" ON "LogoReport"("status");
ALTER TABLE "LogoReport" ADD CONSTRAINT "LogoReport_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
