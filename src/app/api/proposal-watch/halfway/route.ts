import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/proposal-watch/halfway?token=...&on=0|1 — the midpoint reminder, on or off, in one click.
//
// Its own link rather than a setting behind a sign-in, because there is no sign-in: the alert in
// the reader's inbox is the only place this preference is reachable from. Every alert carries
// whichever direction the subscriber does not currently have.
//
// EXPLICIT on=0 / on=1 rather than a toggle. A link that flips state does the wrong thing when a
// mail client prefetches it, when the reader taps twice, or when they open last week's email after
// changing their mind: all three are real, and all three end with the opposite of what was clicked.
export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const on = req.nextUrl.searchParams.get("on");
  const base = process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin;

  if (token && (on === "0" || on === "1")) {
    await prisma.proposalWatch.updateMany({
      where: { token },
      data: { halfway: on === "1" },
    });
  }
  // The destination states which way it now is, so a prefetch that lands here without the reader
  // seeing it still leaves a page that tells them the truth when they do arrive.
  return NextResponse.redirect(`${base}/proposals/reminders?on=${on === "1" ? "1" : "0"}`);
}
