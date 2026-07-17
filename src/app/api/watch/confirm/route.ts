import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/watch/confirm?token=... — followed from the double opt-in email. Flips the watch to
// confirmed so it will receive flag notices, then redirects to a friendly status page. Idempotent:
// an already-confirmed or unknown token still lands on the status page (no token-probing signal).
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const base = req.nextUrl.origin;

  if (token) {
    const watch = await prisma.providerWatch.findUnique({ where: { token } });
    if (watch && !watch.confirmed) {
      await prisma.providerWatch.update({
        where: { token },
        data: { confirmed: true, confirmedAt: new Date() },
      });
    }
  }
  // Always land on the same page regardless of token validity, so the link can't be used to probe
  // which tokens exist.
  return NextResponse.redirect(`${base}/watch/confirmed`);
}
