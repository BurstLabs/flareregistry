-- Their anonymised Provider_NNN labels are Flare systems-explorer entity ids, so they resolve to a real
-- identity address. Joining on address instead of name lets unlisted providers be cross-referenced.
ALTER TABLE "ExternalDetection" ADD COLUMN "identityAddress" TEXT;
CREATE INDEX "ExternalDetection_identityAddress_idx" ON "ExternalDetection"("identityAddress");
