import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { addressSchema } from "@/lib/validation";

// GET /api/provider/:address  -> the provider profile that owns this address, with all its
// addresses and their verification state. Public read.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  const { address } = await params;
  const parsed = addressSchema.safeParse(address);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }

  const owned = await prisma.providerAddress.findFirst({
    where: { address: parsed.data },
    include: { provider: { include: { addresses: true } } },
  });
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
    algorithm: p.algorithm,
    addresses: p.addresses.map((a) => ({
      chainId: a.chainId,
      address: a.address,
      verified: a.verified,
    })),
  });
}
