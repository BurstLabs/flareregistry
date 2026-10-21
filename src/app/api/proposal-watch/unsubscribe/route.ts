import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/proposal-watch/unsubscribe?token=... — the one-click leave link in every alert.
//
// DELETES the row rather than flagging it. There is nothing worth keeping: the address is the whole
// record, and holding it after someone has asked to be left alone is the thing they were asking us
// not to do. The cascade takes the sent-notice rows with it.
//
// Idempotent and uninformative, like confirm: an unknown token still lands on the page.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const base = process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin;
  if (token) await prisma.proposalWatch.deleteMany({ where: { token } });
  return NextResponse.redirect(`${base}/proposals/unsubscribed`);
}
