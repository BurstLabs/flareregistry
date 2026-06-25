import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { loadMembers, memberVoterFor } from "@/lib/governance";

// POST /api/governance/add-grounds
// The Management Group member who raised a flag adds a SUPPLEMENTAL grounds entry (e.g. new
// evidence found later). It is informational only: it does not count as another co-initiation and
// does not affect quorum or voting. Each entry is independently editable with its own history.
// Allowed only while the case is still pre-vote (PENDING or OPEN_DISCUSSION).
// Body: { caseId, message, signature, grounds }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const caseId = typeof body?.caseId === "string" ? body.caseId : null;
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  const grounds = typeof body?.grounds === "string" ? body.grounds.trim() : null;
  if (!caseId || !message || !signature || !grounds) {
    return NextResponse.json(
      { error: "caseId, message, signature, and grounds are required" },
      { status: 400 }
    );
  }
  if (grounds.length < 10 || grounds.length > 2000) {
    return NextResponse.json(
      { error: "grounds must be between 10 and 2000 characters" },
      { status: 400 }
    );
  }
  if (!isClean(grounds)) {
    return NextResponse.json({ error: "grounds contain inappropriate language" }, { status: 400 });
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

  const theCase = await prisma.providerFlagCase.findUnique({
    where: { id: caseId },
    include: { initiations: true },
  });
  if (!theCase) return NextResponse.json({ error: "case not found" }, { status: 404 });

  if (theCase.state !== "PENDING" && theCase.state !== "OPEN_DISCUSSION") {
    return NextResponse.json(
      { error: "grounds can no longer be added once voting has opened" },
      { status: 409 }
    );
  }

  const mine = theCase.initiations.find((i) => i.memberEntityVoter === memberVoter);
  if (!mine) {
    return NextResponse.json(
      { error: "you have not flagged this provider, so you cannot add grounds" },
      { status: 403 }
    );
  }

  const entry = await prisma.providerFlagGroundsEntry.create({
    data: { initiationId: mine.id, grounds, signerAddress: verified.address! },
  });
  await prisma.providerFlagGroundsEntryRevision.create({
    data: { entryId: entry.id, grounds, signerAddress: verified.address! },
  });

  return NextResponse.json({ ok: true, entryId: entry.id });
}
