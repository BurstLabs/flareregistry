import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionAddress } from "@/lib/session";
import { publishFeedToRepo } from "@/lib/feed";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";
import { normalizeName } from "@/lib/validation";
import { listingAddressesForSigner } from "@/lib/metrics";

// POST /api/provider/delete  -> permanently remove the caller's ENTIRE listing.
//
// The most destructive action, so it is gated:
//   - The caller must be signed in with an address that belongs to the listing (proof of ownership).
//   - The body must echo the listing's exact name as a confirmation (guards against a stray call).
// Deleting the Provider cascades to its addresses, so the listing
// vanishes from the registry and the feed. The provider can then list again from scratch.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "submit", 10, 60_000);
  if (limited) return limited;

  const session = await getSessionAddress();
  if (!session) {
    return apiError("NOT_AUTHENTICATED", "not authenticated", 401);
  }

  const body = await req.json().catch(() => null);
  const confirmName = typeof body?.name === "string" ? body.name : null;
  if (!confirmName) {
    return NextResponse.json({ error: "name confirmation is required" }, { status: 400 });
  }

  // The listing the caller owns. The session may be a stored listing address OR any of the entity's
  // five on-chain role addresses, so match by the session plus its full role set.
  const ownerKeys = [session.toLowerCase(), ...(await listingAddressesForSigner(session))];
  const owned = await prisma.providerAddress.findFirst({
    where: { address: { in: ownerKeys } },
    select: { providerId: true, provider: { select: { name: true } } },
  });
  if (!owned) {
    return NextResponse.json({ error: "you have no listing" }, { status: 404 });
  }

  // The confirmation name must match the listing exactly (case/space-insensitive).
  // Use the shared name normaliser (S14: one rule everywhere a name is compared).
  if (normalizeName(confirmName) !== normalizeName(owned.provider.name)) {
    return NextResponse.json(
      { error: `the name does not match your listing ("${owned.provider.name}")` },
      { status: 409 }
    );
  }

  // Cascades to ProviderAddress + ProviderFlagCase.
  // A CONDUCT CASE BLOCKS DELETION, and this is the same hole that was closed on the admin side.
  // Without it, self-service deletion is an undo button for an adjudicated finding: the subject of a
  // case could remove their listing and take the record with them, then list again from scratch. The
  // FK is RESTRICT so the database would refuse anyway, but a checked refusal with a reason beats a
  // raw constraint error.
  const conduct = await prisma.providerFlagCase.count({
    where: { providerId: owned.providerId, kind: "CONDUCT" },
  });
  if (conduct > 0) {
    return NextResponse.json(
      {
        error:
          "this listing carries a Management Group conduct case; the case is a permanent record and the listing cannot be deleted",
      },
      { status: 409 }
    );
  }
  await prisma.provider.delete({ where: { id: owned.providerId } });

  await publishFeedToRepo();
  return NextResponse.json({ ok: true, deleted: owned.provider.name });
}
