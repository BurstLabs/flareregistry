import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import {
  evaluateOutcome,
  loadMembers,
  QUORUM_TURNOUT_BIPS,
  DENY_MAJORITY_BIPS,
  isCasePublic,
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
        include: {
          revisions: { orderBy: { createdAt: "asc" } },
          entries: {
            orderBy: { createdAt: "asc" },
            include: { revisions: { orderBy: { createdAt: "asc" } } },
          },
        },
      },
      votes: { orderBy: { createdAt: "asc" } },
      defense: {
        include: {
          revisions: { orderBy: { createdAt: "asc" } },
          entries: {
            orderBy: { createdAt: "asc" },
            include: { revisions: { orderBy: { createdAt: "asc" } } },
          },
        },
      },
    },
  });
  // A sealed CONDUCT case must be indistinguishable from one that does not exist. 404 rather than
  // 403, so the response never confirms that an unpublished accusation exists.
  if (!c || !isCasePublic(c)) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Live member count for the quorum display (best-effort; fall back to the open snapshot).
  let memberCount = c.memberCountAtOpen;
  try {
    memberCount = (await loadMembers()).memberCount;
  } catch {
    // keep snapshot
  }

  const votesCast = c.votes.length;
  const denyVotes = c.votes.filter((v) => v.vote === "DENY").length;
  const keepVotes = c.votes.filter((v) => v.vote === "KEEP").length;
  // DECISIVE VOTES, not turnout. This passed votesCast, so with any abstention on the case the
  // published denyNeeded was measured against the wrong denominator and overstated the bar.
  const decisiveVotes = denyVotes + keepVotes;
  const { turnoutFloor, denyNeeded } = evaluateOutcome(
    memberCount,
    votesCast,
    denyVotes,
    decisiveVotes
  );

  const body = {
    id: c.id,
    providerId: c.provider.id,
    providerName: c.provider.name,
    suspended: c.provider.suspended,
    state: c.state,
    isReVote: c.isReVote,
    // When the flag was first raised (PENDING). The discussion window only starts once the case
    // opens (a 2nd member co-initiates), which is openedAt — these are distinct moments.
    raisedAt: c.createdAt,
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
      // PUBLISHED so the three add up. keepVotes was votesCast - denyVotes, which counted every
      // abstention as a vote to keep: a consumer of this API reading a split of 2/14 had no way to
      // know that fourteen members had declined to take a side rather than opposed the case.
      abstainVotes: c.votes.filter((v) => v.vote === "ABSTAIN").length,
      decisiveVotes,
    },
    initiations: c.initiations.map((i) => ({
      member: i.memberEntityVoter,
      grounds: i.grounds,
      title: i.title,
      at: i.createdAt,
      editedAt: i.editedAt,
      // Public, append-only history. The first row is the original text; later rows are edits.
      // Collapse to just the prior versions (the current text is `grounds` above) for display.
      revisions: i.revisions.map((r) => ({ grounds: r.grounds, at: r.createdAt })),
      // Supplemental entries the same member added later (informational), each with its own history.
      entries: i.entries.map((e) => ({
        id: e.id,
        grounds: e.grounds,
        title: e.title,
        at: e.createdAt,
        editedAt: e.editedAt,
        revisions: e.revisions.map((r) => ({ grounds: r.grounds, at: r.createdAt })),
      })),
    })),
    votes: c.votes.map((v) => ({
      member: v.memberEntityVoter,
      vote: v.vote,
      comment: v.comment,
      at: v.createdAt,
    })),
    defense: c.defense
      ? {
          body: c.defense.body,
          title: c.defense.title,
          at: c.defense.createdAt,
          editedAt: c.defense.editedAt,
          revisions: c.defense.revisions.map((r) => ({ body: r.body, at: r.createdAt })),
          entries: c.defense.entries.map((e) => ({
            id: e.id,
            body: e.body,
            title: e.title,
            at: e.createdAt,
            editedAt: e.editedAt,
            revisions: e.revisions.map((r) => ({ body: r.body, at: r.createdAt })),
          })),
        }
      : null,
    outcome:
      c.decidedAt != null
        ? { state: c.state, turnout: c.outcomeTurnout, deny: c.outcomeDeny, at: c.decidedAt }
        : null,
  };

  return NextResponse.json(body, {
    headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=30" },
  });
}
