import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runProposalAlerts } from "@/lib/proposal-alerts-run";

export const dynamic = "force-dynamic";

// GET /api/proposal-watch/confirm?token=... — the double opt-in link.
//
// Idempotent, and deliberately uninformative: an unknown or already-used token lands on the same
// page as a good one. Anything else would make this endpoint a way to test whether a token, and so
// an address, is on the list.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  // The PUBLIC base, not req.nextUrl.origin: behind Cloudflare the app's own origin is the internal
  // host (http://localhost:3060), which is not reachable from the reader's browser.
  const base = process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin;

  if (token) {
    // updateMany, so an unknown token is a no-op rather than a throw.
    const { count } = await prisma.proposalWatch.updateMany({
      where: { token, confirmed: false },
      data: { confirmed: true, confirmedAt: new Date() },
    });

    // SWEEP IMMEDIATELY ON THE TRANSITION, rather than leaving them to the next cron tick.
    //
    // Someone confirming while votes are already open and past their midpoint is owed those
    // midpoint nudges now. Waiting up to ten minutes means the first thing the feature does is look
    // broken: they click confirm, go to their inbox, and nothing is there. That is not a guess, it
    // is what happened on the day this shipped.
    //
    // Gated on count === 1, so only the actual unconfirmed-to-confirmed transition triggers it. A
    // re-followed link, a prefetched one, or a stranger guessing tokens all update nothing and
    // sweep nothing. The sweep claims every send behind a unique index anyway, so even if it did
    // run twice nobody is mailed twice.
    //
    // NOT AWAITED: the reader gets their redirect now, and the sweep finishes behind it on a
    // long-lived server. Failures are logged rather than surfaced, because the confirmation
    // genuinely did succeed and the cron will pick up anything this run missed.
    if (count === 1) {
      void runProposalAlerts().catch((e) =>
        console.error("[proposal-watch] post-confirm sweep failed:", e instanceof Error ? e.message : e)
      );
    }
  }
  return NextResponse.redirect(`${base}/proposals/subscribed`);
}
