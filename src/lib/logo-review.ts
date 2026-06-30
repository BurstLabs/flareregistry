// Shared constant for the logo review window. A newly uploaded logo is held this many days before it
// goes live, so an inappropriate image is not published instantly. Configurable via LOGO_REVIEW_DAYS.
export const LOGO_REVIEW_DAYS = Number(process.env.LOGO_REVIEW_DAYS ?? "7") || 7;

/** When a logo uploaded at `uploadedAt` becomes eligible to go live. */
export function logoGoLiveAt(uploadedAt: Date): Date {
  return new Date(uploadedAt.getTime() + LOGO_REVIEW_DAYS * 24 * 60 * 60 * 1000);
}

// Imported lazily inside the function to keep this module import-light for the upload route.
/**
 * Promote every pending logo whose review window has elapsed: copy assets/pending/<addr>.png over the
 * live logo, point the provider's logoURI at it, and clear the pending fields. Returns how many were
 * promoted. Safe to run repeatedly (a cron). Republishes the feed if any were promoted.
 */
export async function promoteDueLogos(): Promise<{ promoted: number }> {
  const { prisma } = await import("./db");
  const { promotePendingLogo } = await import("./github");
  const { publishFeedToRepo } = await import("./feed");

  const cutoff = new Date(Date.now() - LOGO_REVIEW_DAYS * 24 * 60 * 60 * 1000);
  const due = await prisma.provider.findMany({
    where: { logoPendingAt: { not: null, lte: cutoff } },
    include: { addresses: { where: { verified: true }, select: { address: true } } },
  });

  let promoted = 0;
  for (const p of due) {
    // The pending file is keyed by the uploader's address; fall back to any verified address.
    const key = p.logoPendingSigner ?? p.addresses[0]?.address;
    if (!key) continue;
    try {
      const liveURL = await promotePendingLogo(key);
      await prisma.provider.update({
        where: { id: p.id },
        data: {
          logoURI: liveURL ?? p.logoPendingURI,
          logoPath: null,
          logoPendingURI: null,
          logoPendingAt: null,
          logoPendingSigner: null,
        },
      });
      promoted++;
    } catch {
      // Leave it pending; the next run will retry.
    }
  }
  if (promoted > 0) await publishFeedToRepo().catch(() => {});
  return { promoted };
}
