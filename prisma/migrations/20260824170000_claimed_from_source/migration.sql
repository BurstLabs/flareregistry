-- What a listing was immediately before it was claimed. Claiming overwrites source with
-- "submitted", so the previous value is otherwise unrecoverable.
ALTER TABLE "Provider" ADD COLUMN "claimedFromSource" TEXT;

-- Backfill every already-claimed listing as 'imported'.
--
-- We cannot recover the true prior value for existing rows, so this picks the answer that cannot
-- harm anyone. Treating a claim as previously-imported means no review window, which leaves these
-- providers exactly where they already were: in the feed. The opposite guess would pull live
-- providers out of wallets on the strength of an assumption. Every claim from here on records the
-- real value at the moment it happens.
UPDATE "Provider" p
SET "claimedFromSource" = 'imported'
WHERE p."claimedFromSource" IS NULL
  AND EXISTS (
    SELECT 1 FROM "ProviderAddress" a
    WHERE a."providerId" = p.id AND a."verified" = true
  );
