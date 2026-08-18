-- Precomputed reputation, so the directory can show a score per card without running the full
-- scorer (~14 queries per provider) for every listing on a force-dynamic page.
CREATE TABLE "ProviderScore" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "voter" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "baseScore" DOUBLE PRECISION NOT NULL,
    "band" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderScore_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderScore_network_voter_key" ON "ProviderScore"("network", "voter");
CREATE INDEX "ProviderScore_version_idx" ON "ProviderScore"("version");
