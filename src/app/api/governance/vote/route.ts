import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { loadMembers, memberVoterFor, isVotingOpen } from "@/lib/governance";
import { apiError } from "@/lib/api-error";

// POST /api/governance/vote
// A Management Group member casts a DENY or KEEP vote during a case's voting period.
// One vote per member entity per case. Body: { caseId, vote, message, signature, comment? }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const caseId = typeof body?.caseId === "string" ? body.caseId : null;
  const vote =
    body?.vote === "DENY" || body?.vote === "KEEP" || body?.vote === "ABSTAIN" ? body.vote : null;
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  const comment = typeof body?.comment === "string" ? body.comment.trim() : null;
  if (!caseId || !vote || !message || !signature) {
    return NextResponse.json(
      { error: "caseId, vote (DENY|KEEP|ABSTAIN), message, and signature are required" },
      { status: 400 }
    );
  }
  if (comment && (comment.length > 2000 || !isClean(comment))) {
    return apiError("COMMENT_INVALID", "comment too long or inappropriate", 400);
  }

  const theCase = await prisma.providerFlagCase.findUnique({ where: { id: caseId } });
  if (!theCase) return apiError("CASE_NOT_FOUND", "case not found", 404);

  const now = new Date();
  if (!isVotingOpen(theCase, now)) {
    return apiError(
      "VOTING_NOT_OPEN",
      "voting is not open for this case (it is in discussion or already decided)",
      409
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
    return apiError("MEMBERSHIP_UNVERIFIED", "could not verify Management Group membership", 503);
  }
  const memberVoter = memberVoterFor(verified.address, members.voterByAddress);
  if (!memberVoter) {
    return apiError(
      "NOT_A_MEMBER",
      "the signing address is not a current Management Group member",
      403
    );
  }

  // A member may change their vote while voting is open. The current choice is upserted onto
  // ProviderFlagVote (one row per member, what the tally counts); every cast and change is also
  // appended to ProviderFlagVoteRevision so the full history stays on the public record.
  const existing = await prisma.providerFlagVote.findUnique({
    where: { caseId_memberEntityVoter: { caseId, memberEntityVoter: memberVoter } },
  });
  const changed =
    !existing || existing.vote !== vote || (existing.comment ?? null) !== (comment || null);

  if (existing && !changed) {
    // Re-submitting the identical vote+comment is a no-op; don't pad the history.
    return NextResponse.json({ ok: true, unchanged: true });
  }

  await prisma.$transaction([
    prisma.providerFlagVote.upsert({
      where: { caseId_memberEntityVoter: { caseId, memberEntityVoter: memberVoter } },
      create: {
        caseId,
        memberEntityVoter: memberVoter,
        signerAddress: verified.address,
        vote,
        comment: comment || null,
      },
      update: {
        signerAddress: verified.address,
        vote,
        comment: comment || null,
      },
    }),
    prisma.providerFlagVoteRevision.create({
      data: {
        caseId,
        memberEntityVoter: memberVoter,
        signerAddress: verified.address,
        vote,
        comment: comment || null,
      },
    }),
  ]);

  return NextResponse.json({ ok: true, changed: !!existing });
}
