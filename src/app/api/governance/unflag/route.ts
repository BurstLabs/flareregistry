import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { loadMembers, memberVoterFor } from "@/lib/governance";
import { apiError } from "@/lib/api-error";

// POST /api/governance/unflag
// A member withdraws their own co-initiation. Only allowed while the case is still PENDING (i.e.
// before a second member has joined and opened it). Removing the last initiation ARCHIVES the case
// as WITHDRAWN (state preserved + readable) rather than deleting it, so the record of the flag, its
// grounds, and any provider response is not lost. A withdrawn flag never opened, so it does not
// consume the provider's one-flag chance.
// Body: { caseId, message, signature }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const caseId = typeof body?.caseId === "string" ? body.caseId : null;
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  if (!caseId || !message || !signature) {
    return NextResponse.json({ error: "caseId, message, and signature are required" }, { status: 400 });
  }

  const theCase = await prisma.providerFlagCase.findUnique({ where: { id: caseId } });
  if (!theCase) return apiError("CASE_NOT_FOUND", "case not found", 404);
  if (theCase.state !== "PENDING") {
    return apiError(
      "FLAG_ALREADY_OPENED",
      "the case has already opened; a flag can only be withdrawn before a second member joins",
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
  // A member may sign with ANY of their five on-chain entity role addresses; memberVoterFor resolves
  // any of the five back to the member.
  const memberVoter = memberVoterFor(verified.address, members.voterByAddress);
  if (!memberVoter) {
    return apiError("NOT_A_MEMBER", "the signing address is not a current Management Group member", 403);
  }

  const mine = await prisma.providerFlagInitiation.findUnique({
    where: { caseId_memberEntityVoter: { caseId, memberEntityVoter: memberVoter } },
  });
  if (!mine) {
    return apiError("NOT_CO_INITIATOR", "you have not co-initiated this flag", 404);
  }

  const totalInitiations = await prisma.providerFlagInitiation.count({ where: { caseId } });

  const remaining = await prisma.$transaction(async (tx) => {
    if (totalInitiations > 1) {
      // Other co-initiators remain: just remove this member's initiation; the case lives on.
      await tx.providerFlagInitiation.delete({ where: { id: mine.id } });
      return totalInitiations - 1;
    }
    // This is the last co-initiator. ARCHIVE the case as WITHDRAWN instead of deleting it, and KEEP
    // the initiation (its grounds + history are the record we are preserving). The case never opened,
    // so the provider's one-flag chance is untouched (flaggedOnce stays false). The member is marked
    // as the withdrawer for the public record.
    await tx.providerFlagInitiation.update({
      where: { id: mine.id },
      data: { withdrawnAt: new Date() },
    });
    await tx.providerFlagCase.update({
      where: { id: caseId },
      data: { state: "WITHDRAWN", decidedAt: new Date() },
    });
    return 0;
  });

  return NextResponse.json({ ok: true, remaining, caseClosed: remaining === 0 });
}
