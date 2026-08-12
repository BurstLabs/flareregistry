CREATE TABLE "ProviderChill" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "beneficiary" TEXT NOT NULL,
    "untilEpoch" INTEGER NOT NULL,
    "contract" TEXT NOT NULL,
    "blockNumber" INTEGER NOT NULL,
    "txHash" TEXT NOT NULL,
    "appliedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderChill_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderChill_network_beneficiary_txHash_key" ON "ProviderChill"("network", "beneficiary", "txHash");
CREATE INDEX "ProviderChill_network_beneficiary_idx" ON "ProviderChill"("network", "beneficiary");
