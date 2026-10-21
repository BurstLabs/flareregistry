// OPT-IN EMAIL FOR THE MANAGEMENT GROUP PROPOSAL FEED.
//
// Anyone, with no wallet and no account, can ask to be told when a new proposal opens for voting,
// and optionally again when half the window has gone. The second message is the point of the
// feature: these windows are short and the recurring failure on /proposals is a proposal that
// misses quorum because members did not notice it in time, not one that is voted down.
//
// Modelled on lib/watch (ProviderWatch), and different in the one way that matters: a watch there is
// on a single provider inside a review window, so it has an end and the email is shredded at it. A
// watch here is on the FEED. Nothing ends it, so it lasts until the subscriber says otherwise, and
// every message has to carry the controls that let them say so.
//
// WHAT THE SUBSCRIBER CAN DO FROM ANY EMAIL, without signing in to anything:
//   - unsubscribe entirely
//   - turn the halfway reminder off, if they are getting one they no longer want
//   - turn the halfway reminder on, if they did not ask for it when they signed up
// All three are one click on a tokenised link, because an unsubscribe that takes a form is an
// unsubscribe people answer with the spam button instead.

import { randomBytes } from "node:crypto";
import { prisma } from "./db";
import { outcomeOf } from "./mg-proposals";

/**
 * Only the fields this module reads.
 *
 * Structural rather than MgProposalView, because the view is assembled by the page out of tallies,
 * quorum arithmetic and snapshots that an email has no use for. fetchMgProposals returns the plain
 * row, so asking for the view here would mean building one just to throw it away.
 */
export interface AlertableProposal {
  id: number;
  contract: string;
  name: string | null;
  summary: string | null;
  voteStartAt: string;
  voteEndAt: string;
  chainState: number;
}

/** A URL-safe random token, used for the confirm, unsubscribe and halfway-toggle links alike. */
export function newProposalWatchToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The key a proposal is recorded under, matching participationKey and the page fragments. */
export function proposalNoticeKey(contract: string, id: number): string {
  return `${contract.toLowerCase()}:${id}`;
}

export type NoticeKind = "new" | "halfway";

/**
 * Is this proposal past the midpoint of its voting window?
 *
 * Measured against the window the proposal itself carries rather than a fixed number of hours: the
 * Management Group's windows have not always been 48 hours and a future one need not be.
 */
export function pastHalfway(p: { voteStartAt: string; voteEndAt: string }, now: Date): boolean {
  const start = new Date(p.voteStartAt).getTime();
  const end = new Date(p.voteEndAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  return now.getTime() >= start + (end - start) / 2;
}

/**
 * The proposals a given notice kind is due for, given the clock.
 *
 * OPEN ONLY, both kinds. A "new proposal" mail about a vote that has already closed is worse than
 * no mail: it asks the reader to go and do something they can no longer do. The same goes double
 * for a midpoint nudge, which exists purely to buy a vote.
 *
 * The backstop against mailing a long backlog the first time this runs is not here but in the
 * caller: a subscriber is only ever sent proposals that opened after they confirmed.
 */
export function dueProposals<T extends AlertableProposal>(
  proposals: T[],
  kind: NoticeKind,
  now: Date
): T[] {
  // outcomeOf is the page's own rule, reused rather than re-derived: "open" here has to mean
  // exactly what it means on /proposals, or a member is mailed about a vote the site calls closed.
  const open = proposals.filter((p) => outcomeOf(p, now) === "open");
  return kind === "new" ? open : open.filter((p) => pastHalfway(p, now));
}

/** Confirmed subscribers, with what has already been sent to each. */
export async function activeWatches() {
  return prisma.proposalWatch.findMany({
    where: { confirmed: true },
    include: { notices: { select: { proposalKey: true, kind: true } } },
  });
}

/** Resend's free tier. Override if the plan changes; the warning threshold follows it. */
export const DAILY_MAIL_CAP = Number(process.env.SUBSCRIBER_MAIL_DAILY_CAP || 100);
/** Warn the operator once the day's sends reach this share of the cap. */
export const MAIL_WARN_AT = 0.8;

/** Start of the current UTC day, which is the window Resend counts in. */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Record that a notice was sent, and say whether this call is the one that recorded it.
 *
 * The unique index is the actual guard, not this function: two overlapping runs both see an empty
 * row, both try to insert, and exactly one succeeds. The loser gets a constraint violation, which
 * is the right answer and is reported as "already sent" rather than thrown, so a duplicate cron
 * tick is a no-op instead of a failure.
 */
export async function claimNotice(
  watchId: string,
  proposalKey: string,
  kind: NoticeKind,
  status: "claimed" | "skipped" = "claimed"
): Promise<boolean> {
  try {
    await prisma.proposalNotice.create({ data: { watchId, proposalKey, kind, status } });
    return true;
  } catch {
    return false;
  }
}

/** Mark how a claimed notice actually ended up, which is what the daily count reads. */
export async function settleNotice(
  watchId: string,
  proposalKey: string,
  kind: NoticeKind,
  status: "sent" | "failed"
): Promise<void> {
  await prisma.proposalNotice.updateMany({
    where: { watchId, proposalKey, kind },
    data: { status },
  });
}

/**
 * Warn the operator, at most once a day, when subscriber mail is near or over its daily cap.
 *
 * The day row is claimed BEFORE the warning is sent, for the same reason every alert is: the unique
 * index is what makes "once a day" true across overlapping runs, and a warning that is sent first
 * and recorded second is a warning that repeats on every tick if the recording fails.
 *
 * Counts only what actually went out. Claims recorded as "skipped" are backlog proposals nobody was
 * mailed about, and counting them would raise a false alarm the first time a subscriber signs up.
 */
export async function warnIfMailQuotaLow(now: Date = new Date()): Promise<boolean> {
  const dayStart = new Date(`${utcDayKey(now)}T00:00:00.000Z`);
  const [sent, failed] = await Promise.all([
    prisma.proposalNotice.count({ where: { status: "sent", sentAt: { gte: dayStart } } }),
    prisma.proposalNotice.count({ where: { status: "failed", sentAt: { gte: dayStart } } }),
  ]);
  // Either running out, or already failing. The second matters more: by then subscribers have
  // silently stopped hearing about proposals.
  if (failed === 0 && sent < DAILY_MAIL_CAP * MAIL_WARN_AT) return false;

  const day = utcDayKey(now);
  let claim;
  try {
    claim = await prisma.mailQuotaWarning.create({ data: { day, sent, failed } });
  } catch {
    return false; // another run already warned today
  }

  // AND RELEASE THE DAY IF THE WARNING DOES NOT GO.
  //
  // Claiming first is what stops a warning per cron tick. But this is an alarm, and an alarm that
  // marks itself delivered and then fails to ring is worse than no alarm: found in testing, where
  // the day was claimed by a process with no operator SMTP configured and the warning was never
  // sent again, that day or ever. So a failed send gives the day back and the next tick, ten
  // minutes later, tries again.
  const { sendMailQuotaWarning } = await import("./mailer");
  try {
    await sendMailQuotaWarning({ sent, failed, cap: DAILY_MAIL_CAP });
    return true;
  } catch (e) {
    await prisma.mailQuotaWarning.delete({ where: { id: claim.id } }).catch(() => {});
    console.error("[proposal-alerts] quota warning failed:", e instanceof Error ? e.message : e);
    return false;
  }
}
