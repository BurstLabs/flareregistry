-- Per-epoch validator uptime, so the validator component can be a windowed series rather than a
-- single instantaneous reading. ProviderValidator holds only a current snapshot.
CREATE TABLE "ValidatorUptimeEpoch" (
    "id" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "epochId" INTEGER NOT NULL,
    "nodeId" TEXT NOT NULL,
    "uptimePercent" DOUBLE PRECISION,
    "uptimeMin" DOUBLE PRECISION,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "offlineSamples" INTEGER NOT NULL DEFAULT 0,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ValidatorUptimeEpoch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ValidatorUptimeEpoch_network_epochId_nodeId_key" ON "ValidatorUptimeEpoch"("network", "epochId", "nodeId");
CREATE INDEX "ValidatorUptimeEpoch_network_epochId_idx" ON "ValidatorUptimeEpoch"("network", "epochId");
CREATE INDEX "ValidatorUptimeEpoch_nodeId_idx" ON "ValidatorUptimeEpoch"("nodeId");
