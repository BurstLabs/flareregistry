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
  kind: NoticeKind
): Promise<boolean> {
  try {
    await prisma.proposalNotice.create({ data: { watchId, proposalKey, kind } });
    return true;
  } catch {
    return false;
  }
}
