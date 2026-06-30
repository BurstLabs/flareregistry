import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { addressSchema } from "@/lib/validation";
import { getChainByKey } from "@/lib/chains";

export const dynamic = "force-dynamic";

// GET /api/provider/resolve-role?address=0x..
// Given an address that may be ANY of an entity's five on-chain role addresses, return the network(s)
// it belongs to and that entity's canonical listing address (delegation/voter). Lets the submit flow
// pin the correct chain when a provider signs in with a non-delegation role address. Read-only.
export async function GET(req: NextRequest) {
  const address = (new URL(req.url).searchParams.get("address") ?? "").toLowerCase();
  if (!addressSchema.safeParse(address).success) {
    return NextResponse.json({ error: "invalid address" }, { status: 400 });
  }
  const entities = await prisma.providerOnchain.findMany({
    where: {
      OR: [
        { voter: address },
        { delegationAddress: address },
        { submitAddress: address },
        { submitSignaturesAddress: address },
        { signingPolicyAddress: address },
      ],
    },
    select: { network: true, voter: true, delegationAddress: true },
  });
  const roles = entities
    .map((e) => {
      const chain = getChainByKey(e.network);
      if (!chain) return null;
      return {
        network: e.network,
        chainId: chain.chainId,
        chainName: chain.name,
        listingAddress: (e.delegationAddress ?? e.voter).toLowerCase(),
      };
    })
    .filter(Boolean);
  return NextResponse.json({ roles });
}
