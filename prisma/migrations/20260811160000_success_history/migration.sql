-- Success-rate history. Flare's explorer serves these as a live gauge with no epoch and no historical
-- endpoint, so the past is unrecoverable and the only way to have a series is to start keeping one.
-- Kept in its own table rather than as columns on ProviderMetricEpoch: that table is what the
-- longevity component counts, and rows created ahead of the reward data would each add a phantom
-- epoch of tenure.
CREATE TABLE "ProviderSuccessSnapshot" (
  "id"           TEXT NOT NULL,
  "network"      TEXT NOT NULL,
  "voter"        TEXT NOT NULL,
  "epochId"      INTEGER NOT NULL,
  "primary"      INTEGER,
  "secondary"    INTEGER,
  "availability" INTEGER,
  "takenAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ProviderSuccessSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderSuccessSnapshot_network_voter_epochId_key"
  ON "ProviderSuccessSnapshot"("network","voter","epochId");
CREATE INDEX "ProviderSuccessSnapshot_network_epochId_idx"
  ON "ProviderSuccessSnapshot"("network","epochId");
