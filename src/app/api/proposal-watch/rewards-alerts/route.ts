import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/proposal-watch/rewards-alerts?token=...&on=0|1 — reward-signing alerts, on or off.
//
// The same shape as the halfway toggle, and explicit on=0/on=1 for the same reason: a link that
// flips state does the wrong thing when a mail client prefetches it, when the reader taps twice, or
// when they open last week's email after changing their mind.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const on = req.nextUrl.searchParams.get("on");
  const base = process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin;
  if (token && (on === "0" || on === "1")) {
    await prisma.proposalWatch.updateMany({ where: { token }, data: { rewards: on === "1" } });
  }
  const t = encodeURIComponent(token);
  return NextResponse.redirect(
    `${base}/rewards/alerts?on=${on === "1" ? "1" : "0"}&token=${t}`
  );
}
