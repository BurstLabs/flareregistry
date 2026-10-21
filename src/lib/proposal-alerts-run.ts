import { fetchMgProposals } from "./mg-proposals";
import {
  activeWatches,
  claimNotice,
  dueProposals,
  proposalNoticeKey,
  settleNotice,
  warnIfMailQuotaLow,
  type NoticeKind,
} from "./proposal-watch";
import { sendProposalAlert, publicMailerConfigured } from "./mailer";

// RUNNING THE ALERT SWEEP.
//
// Lives here rather than inside the cron route because two callers need it: the ten-minute cron,
// and the confirm link itself.
//
// The second is why this was extracted. A subscriber who confirms while votes are already open and
// past their midpoint is owed those midpoint nudges, and waiting up to ten minutes for the next
// tick means the first thing the feature does is look broken: they click confirm, go to their
// inbox, and nothing is there. Confirming is a single, token-gated, once-only transition, so it is
// a safe thing to hang a sweep off.
//
// SAFE TO CALL AS OFTEN AS ANYTHING LIKES. Every send is claimed in ProposalNotice behind a unique
// index first, so a duplicate call is a database error rather than a second email, and two
// overlapping runs cannot both win. The claim is written before the send rather than after: a crash
// between the two costs one missed alert, where the other order costs an unbounded number of
// repeats to somebody's inbox on every tick until it stops crashing. Losing a message is
// recoverable by looking at the page; being mailed the same proposal nine times is how a sending
// domain ends up in spam folders.
//
// NOTHING RETROSPECTIVE, FOR "NEW" ONLY. A subscriber is not told a proposal is new when it opened
// before they signed up: the first run after anyone subscribes would otherwise mail them every open
// proposal at once, which reads as a mistake and is the first thing they would unsubscribe from.
// The halfway nudge is exempt, deliberately: a vote that is open, past its midpoint and short of
// quorum is exactly the one a new subscriber can still do something about.
export async function runProposalAlerts(): Promise<{
  watches: number;
  sent: number;
  failed: number;
  warned: boolean;
  skipped?: string;
}> {
  if (!publicMailerConfigured()) {
    return { watches: 0, sent: 0, failed: 0, warned: false, skipped: "public mailer not configured" };
  }

  const now = new Date();
  const proposals = await fetchMgProposals();
  const watches = await activeWatches();
  if (!watches.length) return { watches: 0, sent: 0, failed: 0, warned: false };

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
        // Opened before this address confirmed. For "new" that is not theirs to be told about, and
        // it is recorded as sent so the backlog is skipped once rather than reconsidered forever.
        // For "halfway" it is sent anyway: see the note above.
        const openedBefore =
          !!w.confirmedAt && new Date(p.voteStartAt).getTime() < w.confirmedAt.getTime();
        if (kind === "new" && openedBefore) {
          await claimNotice(w.id, key, kind, "skipped");
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
          await settleNotice(w.id, key, kind, "sent");
          sent++;
        } catch (e) {
          await settleNotice(w.id, key, kind, "failed");
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

  // Running out of room, or already refused. Told to the operator over a different provider, at
  // most once a day. Never allowed to fail the run: the alarm is not more important than the job.
  const warned = await warnIfMailQuotaLow(now).catch(() => false);

  return { watches: watches.length, sent, failed, warned };
}
