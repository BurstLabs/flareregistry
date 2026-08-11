-- Implementation-independence signals mirrored from oracleindependence.com. Stored rather than fetched
-- live so a provider page never depends on another site being reachable.
ALTER TABLE "ProviderOnchain"
  ADD COLUMN "oiClass"     TEXT,
  ADD COLUMN "oiExternalP" DOUBLE PRECISION,
  ADD COLUMN "oiCheckedAt" TIMESTAMP(3);
