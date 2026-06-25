import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { loadMembers, memberVoterFor } from "@/lib/governance";

// POST /api/governance/edit-grounds
// The Management Group member who raised a flag edits one of their grounds entries. The new text
// replaces the current text, but every version is preserved (in ProviderFlagGroundsRevision for the
// primary entry, or ProviderFlagGroundsEntryRevision for a supplemental one) so the public record
// shows exactly what changed and when. Editable only while the case is still pre-vote (PENDING or
// OPEN_DISCUSSION); once voting opens the grounds lock.
// Body: { caseId, message, signature, grounds, entryId? }
//   entryId omitted -> edit the member's PRIMARY grounds (the initiation).
//   entryId present  -> edit that SUPPLEMENTAL grounds entry.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const caseId = typeof body?.caseId === "string" ? body.caseId : null;
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  const grounds = typeof body?.grounds === "string" ? body.grounds.trim() : null;
  const entryId = typeof body?.entryId === "string" ? body.entryId : null;
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

  // Verify the signer controls a current Management Group member address.
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

  // Grounds lock once voting opens (or the case is decided). Only pre-vote stages are editable.
  if (theCase.state !== "PENDING" && theCase.state !== "OPEN_DISCUSSION") {
    return NextResponse.json(
      { error: "grounds can no longer be edited once voting has opened" },
      { status: 409 }
    );
  }

  // The member must own a flag on this case.
  const mine = theCase.initiations.find((i) => i.memberEntityVoter === memberVoter);
  if (!mine) {
    return NextResponse.json(
      { error: "you have not flagged this provider, so there are no grounds to edit" },
      { status: 403 }
    );
  }

  if (entryId) {
    // Editing a supplemental entry: it must belong to this member's flag.
    const entry = await prisma.providerFlagGroundsEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.initiationId !== mine.id) {
      return NextResponse.json({ error: "entry not found on your flag" }, { status: 404 });
    }
    if (entry.grounds.trim() === grounds) {
      return NextResponse.json({ ok: true, unchanged: true });
    }
    await prisma.$transaction([
      prisma.providerFlagGroundsEntry.update({
        where: { id: entry.id },
        data: { grounds, editedAt: new Date() },
      }),
      prisma.providerFlagGroundsEntryRevision.create({
        data: { entryId: entry.id, grounds, signerAddress: verified.address! },
      }),
    ]);
    return NextResponse.json({ ok: true });
  }

  // Editing the primary grounds (the initiation itself).
  // No-op edits should not pollute the history with an identical revision.
  if (mine.grounds.trim() === grounds) {
    return NextResponse.json({ ok: true, unchanged: true });
  }

  await prisma.$transaction([
    prisma.providerFlagInitiation.update({
      where: { id: mine.id },
      data: { grounds, editedAt: new Date() },
    }),
    prisma.providerFlagGroundsRevision.create({
      data: { initiationId: mine.id, grounds, signerAddress: verified.address! },
    }),
  ]);

  return NextResponse.json({ ok: true });
}
