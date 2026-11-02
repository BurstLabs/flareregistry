-- P-chain validator rewards per reward epoch, network-wide, from Flare's reward-scripts repository,
-- so the yield feed's staker rate can include what ValidatorRewardManager pays next to the FSP MIRROR
-- rewards. Additive: a new table, no existing table or column changes. Amounts are wei-scale text,
-- summed in BigInt, never in SQL. Filled by scripts/ingest-validator-rewards.mjs.
CREATE TABLE "ValidatorRewardEpoch" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "epochId" INTEGER NOT NULL,
    "rewardAmount" TEXT NOT NULL,
    "stakerReward" TEXT NOT NULL,
    "feeReward" TEXT NOT NULL,
    "burnedReward" TEXT NOT NULL,
    "delegatorReward" TEXT NOT NULL,
    "totalStake" TEXT NOT NULL,
    "delegatedStake" TEXT NOT NULL,
    "selfBond" TEXT NOT NULL,
    "nodes" INTEGER NOT NULL,
    "rewardedNodes" INTEGER NOT NULL,
    "stakingVpBlock" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ValidatorRewardEpoch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ValidatorRewardEpoch_network_epochId_key" ON "ValidatorRewardEpoch"("network", "epochId");
