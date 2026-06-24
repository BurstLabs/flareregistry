-- CreateTable
CREATE TABLE "ProviderOnchain" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "voter" TEXT NOT NULL,
    "delegationAddress" TEXT,
    "submitAddress" TEXT,
    "submitSignaturesAddress" TEXT,
    "signingPolicyAddress" TEXT,
    "nodeIds" JSONB,
    "feeBips" INTEGER,
    "wNatWeight" TEXT,
    "wNatCappedWeight" TEXT,
    "signingWeight" TEXT,
    "feedCount" INTEGER,
    "registered" BOOLEAN NOT NULL DEFAULT true,
    "goodStanding" BOOLEAN NOT NULL DEFAULT true,
    "lastEpochSeen" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderOnchain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderMetricEpoch" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "epochId" INTEGER NOT NULL,
    "voter" TEXT NOT NULL,
    "feeBips" INTEGER,
    "wNatWeight" TEXT,
    "wNatCappedWeight" TEXT,
    "signingWeight" TEXT,
    "feedCount" INTEGER,
    "feeReward" TEXT,
    "delegatorReward" TEXT,
    "stakerReward" TEXT,
    "registered" BOOLEAN NOT NULL DEFAULT true,
    "goodStanding" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProviderMetricEpoch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestState" (
    "network" TEXT NOT NULL,
    "lastEpochIngested" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestState_pkey" PRIMARY KEY ("network")
);

-- CreateIndex
CREATE INDEX "ProviderOnchain_delegationAddress_idx" ON "ProviderOnchain"("delegationAddress");

-- CreateIndex
CREATE INDEX "ProviderOnchain_submitAddress_idx" ON "ProviderOnchain"("submitAddress");

-- CreateIndex
CREATE INDEX "ProviderOnchain_submitSignaturesAddress_idx" ON "ProviderOnchain"("submitSignaturesAddress");

-- CreateIndex
CREATE INDEX "ProviderOnchain_signingPolicyAddress_idx" ON "ProviderOnchain"("signingPolicyAddress");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderOnchain_network_voter_key" ON "ProviderOnchain"("network", "voter");

-- CreateIndex
CREATE INDEX "ProviderMetricEpoch_network_voter_idx" ON "ProviderMetricEpoch"("network", "voter");

-- CreateIndex
CREATE INDEX "ProviderMetricEpoch_network_epochId_idx" ON "ProviderMetricEpoch"("network", "epochId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderMetricEpoch_network_epochId_voter_key" ON "ProviderMetricEpoch"("network", "epochId", "voter");
