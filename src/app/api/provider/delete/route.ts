import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionAddress } from "@/lib/session";
import { publishFeedToRepo } from "@/lib/feed";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/provider/delete  -> permanently remove the caller's ENTIRE listing.
//
// The most destructive action, so it is gated:
//   - The caller must be signed in with an address that belongs to the listing (proof of ownership).
//   - The body must echo the listing's exact name as a confirmation (guards against a stray call).
// Deleting the Provider cascades to its addresses and flag cases (onDelete: Cascade), so the listing
// vanishes from the registry and the feed. The provider can then list again from scratch.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "submit", 10, 60_000);
  if (limited) return limited;

  const session = await getSessionAddress();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const confirmName = typeof body?.name === "string" ? body.name : null;
  if (!confirmName) {
    return NextResponse.json({ error: "name confirmation is required" }, { status: 400 });
  }

  // The listing the caller owns (holds the session address).
  const owned = await prisma.providerAddress.findFirst({
    where: { address: session },
    select: { providerId: true, provider: { select: { name: true } } },
  });
  if (!owned) {
    return NextResponse.json({ error: "you have no listing" }, { status: 404 });
  }

  // The confirmation name must match the listing exactly (case/space-insensitive).
  const norm = (s: string) => s.trim().toLowerCase();
  if (norm(confirmName) !== norm(owned.provider.name)) {
    return NextResponse.json(
      { error: `the name does not match your listing ("${owned.provider.name}")` },
      { status: 409 }
    );
  }

  // Cascades to ProviderAddress + ProviderFlagCase.
  await prisma.provider.delete({ where: { id: owned.providerId } });

  await publishFeedToRepo();
  return NextResponse.json({ ok: true, deleted: owned.provider.name });
}
