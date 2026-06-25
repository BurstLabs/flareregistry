import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  evaluateOutcome,
  loadMembers,
  QUORUM_TURNOUT_BIPS,
  DENY_MAJORITY_BIPS,
} from "@/lib/governance";

// GET /api/governance/case/:id
// Public, read-only case state for the transparency UI. CORS-open. Everyone sees the same data:
// stage, deadlines, co-initiators + grounds, live tally vs quorum, voters, and the defense.
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const c = await prisma.providerFlagCase.findUnique({
    where: { id },
    include: {
      provider: { select: { id: true, name: true, suspended: true } },
      initiations: {
        orderBy: { createdAt: "asc" },
        include: { revisions: { orderBy: { createdAt: "asc" } } },
      },
      votes: { orderBy: { createdAt: "asc" } },
      defense: true,
    },
  });
  if (!c) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Live member count for the quorum display (best-effort; fall back to the open snapshot).
  let memberCount = c.memberCountAtOpen;
  try {
    memberCount = (await loadMembers()).memberCount;
  } catch {
    // keep snapshot
  }

  const votesCast = c.votes.length;
  const denyVotes = c.votes.filter((v) => v.vote === "DENY").length;
  const keepVotes = votesCast - denyVotes;
  const { turnoutFloor, denyNeeded } = evaluateOutcome(memberCount, votesCast, denyVotes);

  const body = {
    id: c.id,
    providerId: c.provider.id,
    providerName: c.provider.name,
    suspended: c.provider.suspended,
    state: c.state,
    isReVote: c.isReVote,
    openedAt: c.openedAt,
    discussionEndsAt: c.discussionEndsAt,
    votingEndsAt: c.votingEndsAt,
    decidedAt: c.decidedAt,
    quorum: {
      memberCount,
      turnoutFloorBips: QUORUM_TURNOUT_BIPS,
      denyMajorityBips: DENY_MAJORITY_BIPS,
      turnoutFloor, // members who must vote
      denyNeeded, // deny votes needed given current turnout
      votesCast,
      denyVotes,
      keepVotes,
    },
    initiations: c.initiations.map((i) => ({
      member: i.memberEntityVoter,
      grounds: i.grounds,
      at: i.createdAt,
      editedAt: i.editedAt,
      // Public, append-only history. The first row is the original text; later rows are edits.
      // Collapse to just the prior versions (the current text is `grounds` above) for display.
      revisions: i.revisions.map((r) => ({ grounds: r.grounds, at: r.createdAt })),
    })),
    votes: c.votes.map((v) => ({
      member: v.memberEntityVoter,
      vote: v.vote,
      comment: v.comment,
      at: v.createdAt,
    })),
    defense: c.defense?.body ?? null,
    outcome:
      c.decidedAt != null
        ? { state: c.state, turnout: c.outcomeTurnout, deny: c.outcomeDeny, at: c.decidedAt }
        : null,
  };

  return NextResponse.json(body, {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=30" },
  });
}
