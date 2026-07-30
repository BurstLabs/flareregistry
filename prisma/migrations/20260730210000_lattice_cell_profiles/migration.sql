-- Per-cell tick-grid hit profiles. Aggregate lift cannot rank the providers the one-sided screen does
-- not exclude (config size and any median-of-prints implementation both raise it), but WHICH cells a
-- provider over-hits is set by its venue list. Keyed by feed NAME + lattice T, never by feed index.
ALTER TABLE "ProviderSimilarity" ADD COLUMN "latticeCellsJson" JSONB;
ALTER TABLE "ProviderSimilarity" ADD COLUMN "latticeCellsN" INTEGER NOT NULL DEFAULT 0;

-- The positive class those profiles are scored against: our own reference instances, measured against
-- the same per-round field rates.
ALTER TABLE "DetectionCursor" ADD COLUMN "refLatticeCellsJson" JSONB;
ALTER TABLE "DetectionCursor" ADD COLUMN "refLatticeCellsN" INTEGER NOT NULL DEFAULT 0;
