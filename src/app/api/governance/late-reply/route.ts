import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";
import { apiError } from "@/lib/api-error";

// POST /api/governance/late-reply
// The subject of a SUBSTANTIATED conduct finding answers it after the fact.
//
// WHY THIS EXISTS. A conduct finding may be published against a listing nobody had claimed, because
// most of the directory is imported rather than claimed and making unclaimed listings immune would
// leave the mechanism covering almost nobody. The cost of that decision is a finding published
// against someone who had no way to answer, and this is what pays it: the moment an owner claims the
// listing, the reply they never had becomes available, with no deadline.
//
// The finding is NOT removed and the vote is not reopened. The Management Group decided on the
// evidence in front of it; a later reply does not undo that. What it does is appear beside the
// finding with equal prominence, so nobody reads the original silence as agreement.
//
// Body: { caseId, message, signature, body }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const b = await req.json().catch(() => null);
  const caseId = typeof b?.caseId === "string" ? b.caseId : null;
  const message = typeof b?.message === "string" ? b.message : null;
  const signature = typeof b?.signature === "string" ? b.signature : null;
  const text = typeof b?.body === "string" ? b.body.trim() : null;
  if (!caseId || !message || !signature || !text) {
    return NextResponse.json(
      { error: "caseId, message, signature, and body are required" },
      { status: 400 }
    );
  }
  if (text.length < 10 || text.length > 4000) {
    return apiError("GROUNDS_LENGTH", "the reply must be between 10 and 4000 characters", 400);
  }
  if (!isClean(text)) {
    return apiError("INAPPROPRIATE_LANGUAGE", "the reply contains inappropriate language", 400);
  }

  const verified = await verifyChallenge(message, signature, "governance");
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  const signer = verified.address.toLowerCase();

  const theCase = await prisma.providerFlagCase.findUnique({
    where: { id: caseId },
    include: { provider: { include: { addresses: true } }, defense: true },
  });
  if (!theCase) return NextResponse.json({ error: "case not found" }, { status: 404 });
  if (theCase.kind !== "CONDUCT" || !theCase.publishedAt) {
    return NextResponse.json(
      { error: "a late reply applies only to a published conduct finding" },
      { status: 409 }
    );
  }

  // The signer must control a VERIFIED address on the listing, i.e. they have claimed it. That is
  // the same bar the subject would have had to meet to be served in the first place, so claiming is
  // exactly what unlocks the reply.
  const owns = theCase.provider.addresses.some(
    (a) => a.verified && a.address.toLowerCase() === signer
  );
  if (!owns) {
    return apiError(
      "NOT_A_MEMBER",
      "the signing address is not a verified address on this listing",
      403
    );
  }

  // Only where no defence was ever submitted. A subject who was served and answered already has a
  // published defence; this is not a second bite at it.
  if (theCase.defense) {
    return NextResponse.json(
      { error: "this case already carries a defence submitted during the process" },
      { status: 409 }
    );
  }
  if (theCase.lateReplyAt) {
    return NextResponse.json({ error: "a late reply has already been published" }, { status: 409 });
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Stored as the case's defence, so it renders through the existing defence surface with the
    // same prominence as one submitted on time. The distinction that matters to a reader is not
    // WHEN it arrived but that it exists, and lateReplyAt records the when for the record.
    await tx.providerFlagDefense.create({ data: { caseId, body: text } });
    await tx.providerFlagCase.update({ where: { id: caseId }, data: { lateReplyAt: now } });
    await tx.providerCaseAudit.create({
      data: { caseId, action: "LATE_REPLY", actor: signer },
    });
  });

  return NextResponse.json({ ok: true, publishedAt: now.toISOString() });
}
