import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionAddress } from "@/lib/session";
import { publishFeedToRepo } from "@/lib/feed";
import { rateLimit } from "@/lib/rate-limit";
import { apiError } from "@/lib/api-error";

// POST /api/provider/unlink  -> remove an address from the caller's listing.
//
// Auth model mirrors linking: the caller must be signed in with an address that already belongs to
// the same listing (proof they own it). Guardrails:
//   - The target address must belong to the SAME provider as the session.
//   - The listing's LAST address can never be removed (that would orphan the listing, leaving it
//     with no verified owner). Remove the whole listing via a different flow if that is intended.
// Removing an address drops its feed entry immediately.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "submit", 10, 60_000);
  if (limited) return limited;

  const session = await getSessionAddress();
  if (!session) {
    return apiError("NOT_AUTHENTICATED", "not authenticated", 401);
  }

  const body = await req.json().catch(() => null);
  const chainId = typeof body?.chainId === "number" ? body.chainId : null;
  const address = typeof body?.address === "string" ? body.address.toLowerCase() : null;
  if (chainId === null || !address) {
    return NextResponse.json({ error: "chainId and address are required" }, { status: 400 });
  }

  // The listing the caller owns (holds the session address).
  const owned = await prisma.providerAddress.findFirst({
    where: { address: session },
    select: { providerId: true },
  });
  if (!owned) {
    return NextResponse.json({ error: "you have no listing" }, { status: 404 });
  }

  // The address being removed must belong to that same listing.
  const target = await prisma.providerAddress.findUnique({
    where: { chainId_address: { chainId, address } },
    select: { providerId: true },
  });
  if (!target || target.providerId !== owned.providerId) {
    return NextResponse.json(
      { error: "that address is not on your listing" },
      { status: 404 }
    );
  }

  // Never remove the last address, or the listing is left with no owner.
  const total = await prisma.providerAddress.count({
    where: { providerId: owned.providerId },
  });
  if (total <= 1) {
    return NextResponse.json(
      {
        error:
          "this is the only address on your listing and cannot be removed. Link another network first, or contact us to remove the whole listing.",
      },
      { status: 409 }
    );
  }

  await prisma.providerAddress.delete({
    where: { chainId_address: { chainId, address } },
  });

  await publishFeedToRepo();
  return NextResponse.json({ ok: true, removed: { chainId, address } });
}
