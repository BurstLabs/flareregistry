import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

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
    await prisma.proposalWatch.updateMany({
      where: { token, confirmed: false },
      data: { confirmed: true, confirmedAt: new Date() },
    });
  }
  return NextResponse.redirect(`${base}/proposals/subscribed`);
}
