-- P-chain validator rewards per node per reward epoch, from Flare's reward-scripts nodes-data.json and
-- the fsp-rewards files of the same epoch, so /api/feed/validators.json can rank validators on what one
-- staked FLR earned on each. Additive: a new table, no existing table or column changes. Amounts and
-- weights are wei-scale text, divided in BigInt, never in SQL. Filled by
-- scripts/ingest-validator-rewards.mjs.
-- CreateTable
CREATE TABLE "ValidatorNodeEpoch" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "epochId" INTEGER NOT NULL,
    "nodeId" TEXT NOT NULL,
    "identity" TEXT,
    "delegationAddress" TEXT,
    "feePpm" INTEGER NOT NULL,
    "stake" TEXT NOT NULL,
    "rewardingWeight" TEXT NOT NULL,
    "cappedWeight" TEXT NOT NULL,
    "uptimeEligible" BOOLEAN NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "nodeReward" TEXT NOT NULL,
    "feeReward" TEXT NOT NULL,
    "mirrorReward" TEXT NOT NULL,
    "mirrorWeight" TEXT NOT NULL,
    "stakeEnd" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ValidatorNodeEpoch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ValidatorNodeEpoch_network_nodeId_idx" ON "ValidatorNodeEpoch"("network", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "ValidatorNodeEpoch_network_epochId_nodeId_key" ON "ValidatorNodeEpoch"("network", "epochId", "nodeId");

