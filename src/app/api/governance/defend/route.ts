import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";

// POST /api/governance/defend
// The flagged provider posts/updates its public defense statement (visible to everyone). Allowed
// from the moment it is flagged through voting. The provider proves control of one of its listed
// addresses by signing a challenge (same wallet-signature model as the members' actions).
// Body: { caseId, body, message, signature }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const payload = await req.json().catch(() => null);
  const caseId = typeof payload?.caseId === "string" ? payload.caseId : null;
  const text = typeof payload?.body === "string" ? payload.body.trim() : null;
  const message = typeof payload?.message === "string" ? payload.message : null;
  const signature = typeof payload?.signature === "string" ? payload.signature : null;
  const titleProvided = typeof payload?.title === "string";
  const title = titleProvided ? payload.title.trim().slice(0, 120) || null : undefined;
  if (!caseId || !text || !message || !signature) {
    return NextResponse.json(
      { error: "caseId, body, message, and signature are required" },
      { status: 400 }
    );
  }
  if (text.length > 4000) {
    return NextResponse.json({ error: "defense must be at most 4000 characters" }, { status: 400 });
  }
  if (!isClean(text)) {
    return NextResponse.json({ error: "defense contains inappropriate language" }, { status: 400 });
  }

  // Verify the signature and recover the signing address.
  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  const signer = verified.address.toLowerCase();

  const theCase = await prisma.providerFlagCase.findUnique({
    where: { id: caseId },
    include: { provider: { include: { addresses: true } } },
  });
  if (!theCase) return NextResponse.json({ error: "case not found" }, { status: 404 });

  // The signing address must own (verified-claim) the flagged provider.
  const ownsIt = theCase.provider.addresses.some(
    (a) => a.address.toLowerCase() === signer && a.verified
  );
  if (!ownsIt) {
    return NextResponse.json({ error: "only the flagged provider can post a defense" }, { status: 403 });
  }

  // A provider can respond from the moment it is flagged (PENDING, before a second member opens the
  // case) through the open discussion and voting periods. Only a decided case closes the defense.
  if (
    theCase.state !== "PENDING" &&
    theCase.state !== "OPEN_DISCUSSION" &&
    theCase.state !== "OPEN_VOTING"
  ) {
    return NextResponse.json({ error: "the case is decided; the defense is closed" }, { status: 409 });
  }

  // Primary response: create on first post, edit thereafter. Every version is kept as a revision so
  // the public record shows what changed (mirrors the members' grounds history).
  const existing = await prisma.providerFlagDefense.findUnique({ where: { caseId } });
  if (!existing) {
    const created = await prisma.providerFlagDefense.create({
      data: { caseId, body: text, ...(title !== undefined ? { title } : {}) },
    });
    await prisma.providerFlagDefenseRevision.create({
      data: { defenseId: created.id, body: text },
    });
  } else {
    const bodyChanged = existing.body.trim() !== text;
    const titleChanged = title !== undefined && (existing.title ?? null) !== title;
    if (!bodyChanged && !titleChanged) {
      return NextResponse.json({ ok: true, unchanged: true });
    }
    const ops: Prisma.PrismaPromise<unknown>[] = [
      prisma.providerFlagDefense.update({
        where: { id: existing.id },
        data: {
          body: text,
          ...(title !== undefined ? { title } : {}),
          ...(bodyChanged ? { editedAt: new Date() } : {}),
        },
      }),
    ];
    if (bodyChanged) {
      ops.push(prisma.providerFlagDefenseRevision.create({ data: { defenseId: existing.id, body: text } }));
    }
    await prisma.$transaction(ops);
  }

  return NextResponse.json({ ok: true });
}
