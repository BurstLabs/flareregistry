-- Cached third-party detection verdicts, for cross-reference only. Admin-only, never published.
CREATE TABLE "ExternalDetection" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameKey" TEXT NOT NULL,
    "probability" DOUBLE PRECISION,
    "verdict" TEXT,
    "snapshotAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalDetection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExternalDetection_source_nameKey_key" ON "ExternalDetection"("source", "nameKey");
CREATE INDEX "ExternalDetection_source_idx" ON "ExternalDetection"("source");
