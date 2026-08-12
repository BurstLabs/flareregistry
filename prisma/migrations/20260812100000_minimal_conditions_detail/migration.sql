-- Proportional minimal conditions, plus Flare's own strike count, from minimal-conditions.json. The
-- binary eligibleForReward hides where providers actually differ.
ALTER TABLE "ProviderMetricEpoch"
  ADD COLUMN "ftsoHits"     INTEGER,
  ADD COLUMN "ftsoPossible" INTEGER,
  ADD COLUMN "fdcRounds"    INTEGER,
  ADD COLUMN "fdcTotal"     INTEGER,
  ADD COLUMN "fastUpdates"  INTEGER,
  ADD COLUMN "fastExpected" INTEGER,
  ADD COLUMN "stakingOk"    BOOLEAN,
  ADD COLUMN "strikes"      INTEGER,
  ADD COLUMN "passesHeld"   INTEGER;

-- Chill status from VoterRegistry. Never used on Flare to date, but it is the strongest possible
-- negative signal if it ever fires, and it costs one eth_call per entity to read.
ALTER TABLE "ProviderOnchain" ADD COLUMN "chilledUntilEpoch" INTEGER;
