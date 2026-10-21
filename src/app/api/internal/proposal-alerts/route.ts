import { NextRequest, NextResponse } from "next/server";
import { requireInternalAuth } from "@/lib/internal-auth";
import { fetchMgProposals } from "@/lib/mg-proposals";
import {
  activeWatches,
  claimNotice,
  dueProposals,
  proposalNoticeKey,
  type NoticeKind,
} from "@/lib/proposal-watch";
import { sendProposalAlert, publicMailerConfigured } from "@/lib/mailer";

export const dynamic = "force-dynamic";
// The sweep mails one address at a time and a cold proposal read is several seconds; give it room
// rather than have a half-finished run time out mid-list.
export const maxDuration = 300;

// POST /api/internal/proposal-alerts
//
// Sends the Management Group proposal alerts. Secret-gated and driven by cron, like every other
// internal job here.
//
// SAFE TO RUN AS OFTEN AS YOU LIKE, which is the only property that matters in a job that sends
// mail. Every send is claimed in ProposalNotice behind a unique index FIRST, so the duplicate case
// is a database error rather than a second email, and two overlapping runs cannot both win. The
// claim is written before the send rather than after: a crash between the two costs one missed
// alert, where the other order costs an unbounded number of repeats to somebody's inbox on every
// tick until it stops crashing. Losing a message is recoverable by looking at the page; being
// mailed the same proposal nine times is how a sending domain ends up in spam folders.
//
// NOTHING RETROSPECTIVE. A subscriber is only ever told about proposals that opened AFTER they
// confirmed. Without that, the first run after anyone subscribes mails them every open proposal at
// once, which reads as a mistake and is the first thing they would unsubscribe from.
export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;

  if (!publicMailerConfigured()) {
    return NextResponse.json({ ok: true, skipped: "public mailer not configured" });
  }

  const now = new Date();
  const proposals = await fetchMgProposals();
  const watches = await activeWatches();
  if (!watches.length) return NextResponse.json({ ok: true, watches: 0, sent: 0 });

  const due: Record<NoticeKind, typeof proposals> = {
    new: dueProposals(proposals, "new", now),
    halfway: dueProposals(proposals, "halfway", now),
  };

  let sent = 0;
  let failed = 0;
  const base = process.env.PUBLIC_BASE_URL ?? "https://flareregistry.com";

  for (const w of watches) {
    const already = new Set(w.notices.map((n) => `${n.proposalKey}|${n.kind}`));
    const kinds: NoticeKind[] = w.halfway ? ["new", "halfway"] : ["new"];

    for (const kind of kinds) {
      for (const p of due[kind]) {
        const key = proposalNoticeKey(p.contract, p.id);
        if (already.has(`${key}|${kind}`)) continue;
        // Opened before this address confirmed: not theirs to be told about. Recorded as sent so a
        // backlog is skipped once rather than reconsidered on every tick forever.
        const openedBefore =
          !!w.confirmedAt && new Date(p.voteStartAt).getTime() < w.confirmedAt.getTime();
        if (openedBefore) {
          await claimNotice(w.id, key, kind);
          continue;
        }
        // Claim first: see the note above on why this order and not the other.
        if (!(await claimNotice(w.id, key, kind))) continue;
        try {
          await sendProposalAlert({
            to: w.email,
            kind,
            name: p.name ?? `Proposal ${p.id}`,
            summary: p.summary,
            proposalUrl: `${base}/proposals#p-${p.contract.slice(0, 10)}-${p.id}`,
            voteEndAt: p.voteEndAt,
            halfway: w.halfway,
            token: w.token,
          });
          sent++;
        } catch (e) {
          failed++;
          // One bad address must not stop the list. The claim stays, so a permanently broken
          // address is not retried on every tick; the log is where that shows up.
          console.error(
            `[proposal-alerts] send failed for ${w.email} on ${key}/${kind}:`,
            e instanceof Error ? e.message : e
          );
        }
      }
    }
  }

  return NextResponse.json({ ok: true, watches: watches.length, sent, failed });
}
