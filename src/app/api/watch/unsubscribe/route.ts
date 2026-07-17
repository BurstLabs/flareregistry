import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/watch/unsubscribe?token=... — the one-click unsubscribe link in every flag notice (and the
// confirm email). Deletes the watch (the token is unique per watch), then redirects to a status page.
// Idempotent: an unknown/already-removed token still lands on the page, revealing nothing.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const base = req.nextUrl.origin;

  if (token) {
    // deleteMany (not delete) so a missing token is a no-op instead of a 404/throw.
    await prisma.providerWatch.deleteMany({ where: { token } });
  }
  return NextResponse.redirect(`${base}/watch/unsubscribed`);
}
