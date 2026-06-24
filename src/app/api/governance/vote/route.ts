import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { loadMembers, memberVoterFor, isVotingOpen } from "@/lib/governance";

// POST /api/governance/vote
// A Management Group member casts a DENY or KEEP vote during a case's voting period.
// One vote per member entity per case. Body: { caseId, vote, message, signature, comment? }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const caseId = typeof body?.caseId === "string" ? body.caseId : null;
  const vote = body?.vote === "DENY" || body?.vote === "KEEP" ? body.vote : null;
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  const comment = typeof body?.comment === "string" ? body.comment.trim() : null;
  if (!caseId || !vote || !message || !signature) {
    return NextResponse.json(
      { error: "caseId, vote (DENY|KEEP), message, and signature are required" },
      { status: 400 }
    );
  }
  if (comment && (comment.length > 2000 || !isClean(comment))) {
    return NextResponse.json({ error: "comment too long or inappropriate" }, { status: 400 });
  }

  const theCase = await prisma.providerFlagCase.findUnique({ where: { id: caseId } });
  if (!theCase) return NextResponse.json({ error: "case not found" }, { status: 404 });

  const now = new Date();
  if (!isVotingOpen(theCase, now)) {
    return NextResponse.json(
      { error: "voting is not open for this case (it is in discussion or already decided)" },
      { status: 409 }
    );
  }

  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  let members;
  try {
    members = await loadMembers();
  } catch {
    return NextResponse.json({ error: "could not verify Management Group membership" }, { status: 503 });
  }
  const memberVoter = memberVoterFor(verified.address, members.voterByAddress);
  if (!memberVoter) {
    return NextResponse.json(
      { error: "the signing address is not a current Management Group member" },
      { status: 403 }
    );
  }

  try {
    await prisma.providerFlagVote.create({
      data: {
        caseId,
        memberEntityVoter: memberVoter,
        signerAddress: verified.address,
        vote,
        comment: comment || null,
      },
    });
  } catch {
    return NextResponse.json({ error: "you have already voted on this case" }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}
