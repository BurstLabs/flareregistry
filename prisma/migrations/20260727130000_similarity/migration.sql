-- CreateTable
CREATE TABLE "ReferenceSample" (
    "id" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "instance" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReferenceSample_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReferenceSample_round_instance_key" ON "ReferenceSample"("round", "instance");
CREATE INDEX "ReferenceSample_round_idx" ON "ReferenceSample"("round");
CREATE INDEX "ReferenceSample_createdAt_idx" ON "ReferenceSample"("createdAt");

-- CreateTable
CREATE TABLE "ProviderSimilarity" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL DEFAULT 'flare',
    "voter" TEXT NOT NULL,
    "refSimilarityMean" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "refSimilarityVar" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fieldDeviationMean" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "roundsObserved" INTEGER NOT NULL DEFAULT 0,
    "probability" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProviderSimilarity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderSimilarity_network_voter_key" ON "ProviderSimilarity"("network", "voter");
CREATE INDEX "ProviderSimilarity_voter_idx" ON "ProviderSimilarity"("voter");
