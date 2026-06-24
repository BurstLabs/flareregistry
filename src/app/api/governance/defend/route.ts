import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionAddress } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isClean } from "@/lib/content-filter";

// POST /api/governance/defend
// The flagged provider posts/updates its public defense statement (visible to everyone). Allowed
// while a case is open. Authenticated by the provider's own verified session.
// Body: { caseId, body }
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "governance", 10, 60_000);
  if (limited) return limited;

  const session = await getSessionAddress();
  if (!session) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  const payload = await req.json().catch(() => null);
  const caseId = typeof payload?.caseId === "string" ? payload.caseId : null;
  const text = typeof payload?.body === "string" ? payload.body.trim() : null;
  if (!caseId || !text) {
    return NextResponse.json({ error: "caseId and body are required" }, { status: 400 });
  }
  if (text.length > 4000) {
    return NextResponse.json({ error: "defense must be at most 4000 characters" }, { status: 400 });
  }
  if (!isClean(text)) {
    return NextResponse.json({ error: "defense contains inappropriate language" }, { status: 400 });
  }

  const theCase = await prisma.providerFlagCase.findUnique({
    where: { id: caseId },
    include: { provider: { include: { addresses: true } } },
  });
  if (!theCase) return NextResponse.json({ error: "case not found" }, { status: 404 });

  // The session address must own the flagged provider.
  const ownsIt = theCase.provider.addresses.some(
    (a) => a.address.toLowerCase() === session && a.verified
  );
  if (!ownsIt) {
    return NextResponse.json({ error: "only the flagged provider can post a defense" }, { status: 403 });
  }

  // Allow editing while the case is open (until the voting period ends).
  if (theCase.state !== "OPEN_DISCUSSION" && theCase.state !== "OPEN_VOTING") {
    return NextResponse.json({ error: "the case is decided; the defense is closed" }, { status: 409 });
  }

  await prisma.providerFlagDefense.upsert({
    where: { caseId },
    create: { caseId, body: text },
    update: { body: text },
  });

  return NextResponse.json({ ok: true });
}
