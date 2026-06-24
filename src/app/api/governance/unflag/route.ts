import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { loadMembers, memberVoterFor } from "@/lib/governance";

// POST /api/governance/unflag
// A member withdraws their own co-initiation. Only allowed while the case is still PENDING (i.e.
// before a second member has joined and opened it). Removing the last initiation deletes the case.
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
  if (!theCase) return NextResponse.json({ error: "case not found" }, { status: 404 });
  if (theCase.state !== "PENDING") {
    return NextResponse.json(
      { error: "the case has already opened; a flag can only be withdrawn before a second member joins" },
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
    return NextResponse.json({ error: "the signing address is not a current Management Group member" }, { status: 403 });
  }

  const mine = await prisma.providerFlagInitiation.findUnique({
    where: { caseId_memberEntityVoter: { caseId, memberEntityVoter: memberVoter } },
  });
  if (!mine) {
    return NextResponse.json({ error: "you have not co-initiated this flag" }, { status: 404 });
  }

  const remaining = await prisma.$transaction(async (tx) => {
    await tx.providerFlagInitiation.delete({ where: { id: mine.id } });
    const count = await tx.providerFlagInitiation.count({ where: { caseId } });
    // No co-initiators left: drop the empty pending case entirely.
    if (count === 0) await tx.providerFlagCase.delete({ where: { id: caseId } });
    return count;
  });

  return NextResponse.json({ ok: true, remaining, caseClosed: remaining === 0 });
}
