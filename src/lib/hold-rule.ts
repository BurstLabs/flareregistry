/**
 * THE NEW-PROVIDER HOLDS, on their own and with no imports.
 *
 * Split out for the same reason as the voting rule: this decides whether a provider appears in the
 * feed that wallets consume, and a module free of database and network imports can be executed
 * directly by a build guard. The guard first tried to import lib/governance, which pulls in prisma,
 * failed, and silently skipped every assertion, which is worse than having no guard at all.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const NEW_PROVIDER_WINDOW_DAYS = 30; // a provider is flaggable only inside this window
export const NEW_PROVIDER_HOLD_CUTOFF = new Date("2026-07-01T00:00:00Z");

/** Is this provider currently inside the new-provider window (created, not yet qualified, <30d)? */
export function inNewProviderWindow(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() < NEW_PROVIDER_WINDOW_DAYS * DAY_MS;
}

/**
 * When this listing was first CLAIMED, or null if nobody ever has.
 *
 * The earliest verified address, so adding a second network years later does not restart anything.
 */
export function claimAnchor(p: {
  addresses?: { verified: boolean; verifiedAt: Date | null }[] | null;
}): Date | null {
  const t = (p.addresses ?? [])
    .filter((a) => a.verified && a.verifiedAt)
    .map((a) => (a.verifiedAt as Date).getTime());
  return t.length ? new Date(Math.min(...t)) : null;
}

/**
 * The SECOND hold: thirty days from the moment an unclaimed listing was claimed.
 *
 * The entity hold measures how long the provider has existed on-chain, and it cannot do this job.
 * A chain-only entity serves out that window while nobody is watching, because there is nothing to
 * watch: no name, no site, no owner, nothing anyone could review. Then it is claimed, the source
 * flips to "submitted", and it lists at once with its window already spent. The clock elapsed
 * during exactly the period when review was impossible, which is the pre-warm this was built to
 * prevent.
 *
 * What the Management Group reviews at a claim is not the on-chain record, which is measured and
 * needs no review. It is the IDENTITY: the name, the site, the logo, the assertion that this
 * operator is who they say. None of that exists until the claim, so the window has no content
 * before it and cannot honestly begin earlier.
 *
 * Independent of the entity hold rather than replacing it, and a provider lists only once BOTH have
 * run. For an ordinary submitted provider the two start together and nothing changes.
 */
export function isHeldNewClaim(claimedAt: Date | null, now: Date): boolean {
  if (!claimedAt) return false;
  if (claimedAt <= NEW_PROVIDER_HOLD_CUTOFF) return false; // grandfathered, as for the entity clock
  return inNewProviderWindow(claimedAt, now);
}

/**
 * The date the new-provider hold is measured from.
 *
 * NOT the row's createdAt, which is when someone ran an import. An operator importing candidates on
 * a Saturday afternoon created thirteen listings at once for entities that had been registered
 * on-chain for as long as 53 days; every one was then held from the listed feed for thirty days as
 * a new provider, and shown a notice saying it had been held since claiming, which none of them had
 * done. The hold exists to give the Management Group a window on a genuinely new entrant, and an
 * entity two months into its on-chain life is not one.
 *
 * firstSeenAt is null on rows that predate the column and on listings where the two dates agree, so
 * createdAt remains the fallback and nothing depends on a backfill having reached everything.
 */
export function holdAnchor(p: { createdAt: Date; firstSeenAt?: Date | null }): Date {
  return p.firstSeenAt && p.firstSeenAt < p.createdAt ? p.firstSeenAt : p.createdAt;
}

export function isHeldNewProvider(createdAt: Date, now: Date): boolean {
  if (createdAt <= NEW_PROVIDER_HOLD_CUTOFF) return false; // grandfathered launch base
  return inNewProviderWindow(createdAt, now);
}
