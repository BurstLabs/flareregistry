import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";
import { DAILY_MAIL_CAP, MAIL_WARN_AT, utcDayKey } from "@/lib/proposal-watch";

export const dynamic = "force-dynamic";

// GET /api/admin/proposal-alerts
//
// Who is subscribed to the Management Group proposal alerts, what has gone out, and how much room
// is left in the day. Read-only but for the one destructive action below.
//
// THE DAILY FIGURE IS THE REASON THIS TAB EXISTS. Subscriber mail runs on a capped plan and the
// failure mode is silent: sends start being refused and nobody hears about proposals again. There is
// an operator warning for that, but a warning is something you receive once; this is somewhere to
// look before it fires, and somewhere to confirm it was right afterwards.
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const dayStart = new Date(`${utcDayKey(new Date())}T00:00:00.000Z`);

  const [watches, sentToday, failedToday, recent, warnings] = await Promise.all([
    prisma.proposalWatch.findMany({
      orderBy: [{ confirmed: "desc" }, { createdAt: "desc" }],
      select: {
        id: true, email: true, confirmed: true, halfway: true,
        createdAt: true, confirmedAt: true,
        _count: { select: { notices: true } },
      },
    }),
    prisma.proposalNotice.count({ where: { status: "sent", sentAt: { gte: dayStart } } }),
    prisma.proposalNotice.count({ where: { status: "failed", sentAt: { gte: dayStart } } }),
    // What actually went out, newest first. Skipped claims are excluded: they are bookkeeping about
    // a backlog nobody was mailed, and listing them as history would misreport what subscribers saw.
    prisma.proposalNotice.findMany({
      where: { status: { in: ["sent", "failed"] } },
      orderBy: [{ sentAt: "desc" }],
      take: 40,
      select: { proposalKey: true, kind: true, status: true, sentAt: true,
                watch: { select: { email: true } } },
    }),
    prisma.mailQuotaWarning.findMany({ orderBy: [{ day: "desc" }], take: 5 }),
  ]);

  return NextResponse.json({
    watches,
    quota: {
      sentToday,
      failedToday,
      cap: DAILY_MAIL_CAP,
      warnAt: Math.floor(DAILY_MAIL_CAP * MAIL_WARN_AT),
      headroom: Math.max(0, DAILY_MAIL_CAP - sentToday),
    },
    recent,
    warnings,
  });
}

// DELETE /api/admin/proposal-alerts  { id }
//
// Remove one subscriber. The same thing their own unsubscribe link does, available here because the
// operator is the one who hears about a complaint, a typo'd address bouncing, or an address that
// should never have been added. The cascade takes the sent-notice rows with it.
//
// There is deliberately no way to ADD a subscriber from here. Every address on this list got there
// by typing it into the public form and then following a link sent to it; an address an admin typed
// in has consented to nothing, and the double opt-in would be a formality we had quietly dropped.
export async function DELETE(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const b = await req.json().catch(() => null);
  const id = typeof b?.id === "string" ? b.id : null;
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

  const { count } = await prisma.proposalWatch.deleteMany({ where: { id } });
  return NextResponse.json({ ok: true, removed: count });
}
