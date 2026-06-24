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
      const votesCast = validVotes.length;
      const denyVotes = validVotes.filter((v) => v.vote === "DENY").length;
      const { decided } = evaluateOutcome(members.memberCount, votesCast, denyVotes);

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
        if (decided === "DENIED") {
          await tx.provider.update({ where: { id: c.providerId }, data: { suspended: true } });
        } else {
          // CLEARED or FAILED_QUORUM: ensure not suspended (covers a successful appeal).
          await tx.provider.update({ where: { id: c.providerId }, data: { suspended: false } });
        }
      });
      transitions.push({ caseId: c.id, to: decided });
    }
  }

  if (transitions.length) await publishFeedToRepo();
  return NextResponse.json({ ok: true, expired, transitions: transitions.length, detail: transitions });
}
