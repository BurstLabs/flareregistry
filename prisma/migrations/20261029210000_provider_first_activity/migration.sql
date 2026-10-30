-- When a provider first appeared on a network, taken as the earliest transaction its delegation
-- address ever sent. The delegation address spans both FTSO eras (in v1 it was the data-provider
-- address), so it reaches network genesis: Songbird 2021-09, Flare 2022-07.
--
-- Reward data cannot answer this: Flare publishes fsp-rewards only from Flare epoch 228
-- (2024-09-26) and Songbird 196 (2024-06-06), which pins 33% of Flare and 75% of Songbird
-- providers to a single floor date.
--
-- Backfilled by scripts/backfill-first-activity.mjs; null means not yet looked up.
ALTER TABLE "ProviderOnchain" ADD COLUMN "firstActivityAt" TIMESTAMP(3);
