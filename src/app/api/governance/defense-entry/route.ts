import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";

// POST /api/governance/defense-entry
// The flagged provider adds or edits a SUPPLEMENTAL response entry (mirrors the members' supplemental
// grounds). Each entry keeps its own append-only revision history. The provider proves control of a
// listed address by signing a challenge. Allowed from PENDING through voting; a decided case closes
// the defense.
// Body: { caseId, body, message, signature, entryId? }
//   entryId omitted -> add a new supplemental entry.
//   entryId present  -> edit that entry.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const payload = await req.json().catch(() => null);
  const caseId = typeof payload?.caseId === "string" ? payload.caseId : null;
  const text = typeof payload?.body === "string" ? payload.body.trim() : null;
  const entryId = typeof payload?.entryId === "string" ? payload.entryId : null;
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
    return NextResponse.json({ error: "response must be at most 4000 characters" }, { status: 400 });
  }
  if (!isClean(text)) {
    return NextResponse.json({ error: "response contains inappropriate language" }, { status: 400 });
  }

  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json({ error: verified.error ?? "bad signature" }, { status: 401 });
  }
  const signer = verified.address.toLowerCase();

  const theCase = await prisma.providerFlagCase.findUnique({
    where: { id: caseId },
    include: { provider: { include: { addresses: true } }, defense: true },
  });
  if (!theCase) return NextResponse.json({ error: "case not found" }, { status: 404 });

  const ownsIt = theCase.provider.addresses.some(
    (a) => a.address.toLowerCase() === signer && a.verified
  );
  if (!ownsIt) {
    return NextResponse.json({ error: "only the flagged provider can respond" }, { status: 403 });
  }

  if (
    theCase.state !== "PENDING" &&
    theCase.state !== "OPEN_DISCUSSION" &&
    theCase.state !== "OPEN_VOTING"
  ) {
    return NextResponse.json({ error: "the case is decided; the defense is closed" }, { status: 409 });
  }

  // Supplemental entries hang off the primary defense, so a primary response must exist first.
  if (!theCase.defense) {
    return NextResponse.json(
      { error: "post your response first, then you can add more entries" },
      { status: 409 }
    );
  }

  if (entryId) {
    const entry = await prisma.providerFlagDefenseEntry.findUnique({ where: { id: entryId } });
    if (!entry || entry.defenseId !== theCase.defense.id) {
      return NextResponse.json({ error: "entry not found on your response" }, { status: 404 });
    }
    const bodyChanged = entry.body.trim() !== text;
    const titleChanged = title !== undefined && (entry.title ?? null) !== title;
    if (!bodyChanged && !titleChanged) {
      return NextResponse.json({ ok: true, unchanged: true });
    }
    const newTitle = title !== undefined ? title : (entry.title ?? null);
    await prisma.$transaction([
      prisma.providerFlagDefenseEntry.update({
        where: { id: entry.id },
        data: { body: text, title: newTitle, editedAt: new Date() },
      }),
      prisma.providerFlagDefenseEntryRevision.create({
        data: { entryId: entry.id, body: text, title: newTitle },
      }),
    ]);
    return NextResponse.json({ ok: true });
  }

  // New supplemental entry + its first revision.
  const newTitle = title ?? null;
  const entry = await prisma.providerFlagDefenseEntry.create({
    data: { defenseId: theCase.defense.id, body: text, title: newTitle },
  });
  await prisma.providerFlagDefenseEntryRevision.create({
    data: { entryId: entry.id, body: text, title: newTitle },
  });

  return NextResponse.json({ ok: true, entryId: entry.id });
}
