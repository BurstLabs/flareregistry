-- The new-provider hold measured from row creation, so a bulk import made established on-chain
-- entities look brand new. firstSeenAt records when the provider actually became observable.
ALTER TABLE "Provider" ADD COLUMN "firstSeenAt" TIMESTAMP(3);

-- Backfill: the earliest on-chain sighting across any of the listing's addresses, in any role,
-- where that is earlier than the row's own creation. Providers with no on-chain match, and those
-- whose row predates their on-chain record, keep NULL and fall back to createdAt.
UPDATE "Provider" p
SET "firstSeenAt" = sub.first_seen
FROM (
  SELECT pa."providerId" AS pid, MIN(po."createdAt") AS first_seen
  FROM "ProviderAddress" pa
  JOIN "ProviderOnchain" po
    ON lower(pa."address") IN (
      lower(po."voter"),
      lower(coalesce(po."delegationAddress", '')),
      lower(coalesce(po."submitAddress", '')),
      lower(coalesce(po."submitSignaturesAddress", '')),
      lower(coalesce(po."signingPolicyAddress", ''))
    )
  GROUP BY pa."providerId"
) sub
WHERE p.id = sub.pid AND sub.first_seen < p."createdAt";
