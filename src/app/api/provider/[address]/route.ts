import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { addressSchema } from "@/lib/validation";
import { listingAddressesForSigner } from "@/lib/metrics";

// GET /api/provider/:address  -> the provider profile that owns this address, with all its
// addresses and their verification state. Public read. Resolves by a stored listing address OR by
// any of the entity's five on-chain role addresses (so a provider can claim/manage by signing with
// any role, not only the delegation address that is stored on the listing).
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  const parsed = addressSchema.safeParse(address);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }

  let owned = await prisma.providerAddress.findFirst({
    where: { address: parsed.data },
    include: { provider: { include: { addresses: true } } },
  });
  if (!owned) {
    // Fall back to resolving the address as one of an entity's role addresses, then look the listing
    // up by that entity's canonical (delegation) address.
    const canon = await listingAddressesForSigner(parsed.data);
    if (canon.length) {
      owned = await prisma.providerAddress.findFirst({
        where: { address: { in: canon } },
        include: { provider: { include: { addresses: true } } },
      });
    }
  }
  if (!owned) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const p = owned.provider;
  return NextResponse.json({
    id: p.id,
    name: p.name,
    description: p.description,
    url: p.url,
    logoPath: p.logoPath,
    logoURI: p.logoURI,
    // "imported" means seeded from the source list and not yet owner-claimed.
    source: p.source,
    privateNode: p.privateNode,
    singleEntity: p.singleEntity,
    algorithm: p.algorithm,
    addresses: p.addresses.map((a) => ({
      chainId: a.chainId,
      address: a.address,
      verified: a.verified,
    })),
  });
}
