import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";

// POST /api/governance/my-case  { providerId, message, signature }
//
// THE SUBJECT'S VIEW OF A SEALED CASE AGAINST THEM, and the only reliable way a provider learns one
// exists.
//
// A conduct case is sealed, which means it 404s from the public case API, the case page, the index
// and the provider page. That is correct for the public and absurd for the subject: the one party
// who must answer was the only party structurally unable to find out. A 14-day notice period they
// cannot observe protects nobody; it just delays the vote.
//
// There is no other channel. Claiming a listing is a wallet signature and the Provider model has
// never held an email, so `noticeEmail` is opt-in and usually absent. This endpoint is therefore the
// primary mechanism and email is the supplement, not the reverse.
//
// The seal is lifted ONLY for a signer controlling a VERIFIED address on the listing, which is the
// same bar that makes someone the owner anywhere else in this system. It returns the grounds and the
// evidence they are being asked to answer, and nothing about who raised it: the co-initiators become
// public if and when the case is substantiated, and knowing which rivals filed while the case is
// still private invites exactly the retaliation this process should not host.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 20, 60_000);
  if (limited) return limited;

  const b = await req.json().catch(() => null);
  const providerId = typeof b?.providerId === "string" ? b.providerId : null;
  const message = typeof b?.message === "string" ? b.message : null;
  const signature = typeof b?.signature === "string" ? b.signature : null;
  if (!providerId || !message || !signature) {
    return NextResponse.json(
      { error: "providerId, message, and signature are required" },
      { status: 400 }
    );
  }

  const verified = await verifyChallenge(message, signature, "governance");
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  const signer = verified.address.toLowerCase();

  const provider = await prisma.provider.findUnique({
    where: { id: providerId },
    include: { addresses: true },
  });
  if (!provider) return NextResponse.json({ error: "provider not found" }, { status: 404 });

  const owns = provider.addresses.some((a) => a.verified && a.address.toLowerCase() === signer);
  if (!owns) {
    return apiError("NOT_A_MEMBER", "the signing address is not a verified address on this listing", 403);
  }

  const cases = await prisma.providerFlagCase.findMany({
    where: { providerId, kind: "CONDUCT", state: { in: ["NOTICE", "OPEN_DISCUSSION", "OPEN_VOTING"] } },
    orderBy: { openedAt: "desc" },
    include: {
      defense: { select: { id: true } },
      initiations: {
        where: { withdrawnAt: null },
        select: {
          title: true,
          grounds: true,
          endorsement: true,
          evidence: { select: { kind: true, chain: true, ref: true, claim: true } },
        },
      },
    },
  });

  // Record that the subject actually looked. This is what makes "served" a fact rather than an
  // assertion: a case decided as SERVED_NO_DEFENCE against a provider who never once opened it is
  // reporting silence that may only mean they never knew.
  for (const c of cases) {
    const seen = await prisma.providerCaseAudit.findFirst({
      where: { caseId: c.id, action: "SUBJECT_VIEWED" },
    });
    if (!seen) {
      await prisma.providerCaseAudit.create({
        data: { caseId: c.id, action: "SUBJECT_VIEWED", actor: signer },
      });
    }
  }

  return NextResponse.json({
    cases: cases.map((c) => ({
      caseId: c.id,
      state: c.state,
      openedAt: c.openedAt,
      noticeEndsAt: c.noticeEndsAt,
      discussionEndsAt: c.discussionEndsAt,
      votingEndsAt: c.votingEndsAt,
      hasDefence: !!c.defense,
      points: c.initiations.map((i) => ({
        title: i.title,
        grounds: i.grounds,
        endorsement: i.endorsement,
        evidence: i.evidence,
      })),
    })),
  });
}
