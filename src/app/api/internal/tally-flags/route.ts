import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireInternalAuth } from "@/lib/internal-auth";
import { publishFeedToRepo } from "@/lib/feed";
import {
  loadMembers,
  evaluateOutcome,
  PENDING_EXPIRY_DAYS,
  NEW_PROVIDER_WINDOW_DAYS,
} from "@/lib/governance";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

// POST /api/internal/tally-flags
// Secret-gated cron step. Advances governance cases:
//  - PENDING (one member) that has timed out -> deleted.
//  - OPEN_DISCUSSION whose discussion period has ended -> OPEN_VOTING.
//  - cases whose voting period has ended -> tallied against the LIVE Management Group size,
//    applying the quorum math. DENIED suspends the provider; CLEARED/FAILED_QUORUM lift the pause.
// Votes from addresses that are no longer current members are dropped at tally.
export async function POST(req: NextRequest) {
  const denied = requireInternalAuth(req);
  if (denied) return denied;

  const now = new Date();
  const transitions: { caseId: string; to: string }[] = [];

  // 0) Expire stale PENDING flags: a single-member flag is removed once it is older than
  //    PENDING_EXPIRY_DAYS, or once the subject's new-provider window has ended (whichever first).
  const pending = await prisma.providerFlagCase.findMany({
    where: { state: "PENDING" },
    select: { id: true, openedAt: true, provider: { select: { createdAt: true } } },
  });
  let expired = 0;
  for (const c of pending) {
    const tooOld = now.getTime() - c.openedAt.getTime() >= PENDING_EXPIRY_DAYS * DAY_MS;
    const windowEnded =
      now.getTime() - c.provider.createdAt.getTime() >= NEW_PROVIDER_WINDOW_DAYS * DAY_MS;
    if (tooOld || windowEnded) {
      await prisma.providerFlagCase.delete({ where: { id: c.id } });
      expired++;
      transitions.push({ caseId: c.id, to: "EXPIRED" });
    }
  }

  // 1) Discussion -> voting.
  const toVoting = await prisma.providerFlagCase.findMany({
    where: { state: "OPEN_DISCUSSION", discussionEndsAt: { lte: now } },
    select: { id: true },
  });
  for (const c of toVoting) {
    await prisma.providerFlagCase.update({ where: { id: c.id }, data: { state: "OPEN_VOTING" } });
    transitions.push({ caseId: c.id, to: "OPEN_VOTING" });
  }

  // 2) Voting ended -> tally.
  const toTally = await prisma.providerFlagCase.findMany({
    where: {
      state: { in: ["OPEN_VOTING", "OPEN_DISCUSSION"] },
      votingEndsAt: { lte: now },
    },
    include: { votes: true },
  });

  if (toTally.length) {
    let members;
    try {
      members = await loadMembers();
    } catch {
      return NextResponse.json(
        { error: "could not load Management Group for tally; will retry next run" },
        { status: 503 }
      );
    }

    for (const c of toTally) {
      // Only count votes from CURRENT members (dedup is already enforced per member entity).
      const validVotes = c.votes.filter((v) => members.memberAddresses.has(v.memberEntityVoter));
      const votesCast = validVotes.length; // all present members, incl. abstentions (for quorum)
      const denyVotes = validVotes.filter((v) => v.vote === "DENY").length;
      const keepVotes = validVotes.filter((v) => v.vote === "KEEP").length;
      const decisiveVotes = denyVotes + keepVotes; // excludes abstentions (for the deny majority)
      const { decided } = evaluateOutcome(members.memberCount, votesCast, denyVotes, decisiveVotes, {
        isReVote: c.isReVote,
        keepVotes,
      });

      // Suspension effect depends on whether this is a flag or an APPEAL, because the outcomes mean
      // opposite things:
      //   Flag case   - DENIED suspends; CLEARED and FAILED_QUORUM both leave the provider listed.
      //   Appeal      - it must AFFIRMATIVELY overturn the original denial to lift the suspension, so
      //                 only CLEARED (a keep majority) un-suspends. DENIED (deny majority upholds the
      //                 denial) and FAILED_QUORUM (not enough votes to overturn) both KEEP it suspended.
      const suspend = c.isReVote
        ? decided !== "CLEARED" // appeal: only a CLEARED appeal lifts the suspension
        : decided === "DENIED"; // flag: only a DENIED flag suspends
      await prisma.$transaction(async (tx) => {
        await tx.providerFlagCase.update({
          where: { id: c.id },
          data: {
            state: decided,
            decidedAt: now,
            outcomeTurnout: votesCast,
            outcomeDeny: denyVotes,
          },
        });
        await tx.provider.update({ where: { id: c.providerId }, data: { suspended: suspend } });
      });
      transitions.push({ caseId: c.id, to: decided });

      // Notify watchers of the verdict, then shred their emails: the case is now decided, so the
      // provider has left review (denied -> permanently off the feed; cleared -> will list), and we
      // retain subscriber emails only during review. Best-effort; never fail the tally over email.
      try {
        const { notifyWatchers, shredWatches } = await import("@/lib/watch");
        if (!c.isReVote) {
          await notifyWatchers(c.providerId, `Management Group case was decided: ${decided}`);
        }
        await shredWatches(c.providerId);
      } catch (e) {
        console.error("[watch] verdict notify/shred failed:", e instanceof Error ? e.message : e);
      }
    }
  }

  if (transitions.length) await publishFeedToRepo();
  return NextResponse.json({ ok: true, expired, transitions: transitions.length, detail: transitions });
}
