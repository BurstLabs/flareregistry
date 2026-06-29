import { NextRequest, NextResponse } from "next/server";
import { isRegisteredOnchain } from "@/lib/metrics";
import { getChain } from "@/lib/chains";

export const dynamic = "force-dynamic";

// GET /api/provider/registration?address=0x..&chainId=14
// Lightweight read-only check of whether an address is a registered on-chain FTSO entity on the
// given chain, so the submit flow can warn an unregistered address up front (right after sign-in)
// instead of only when the listing is published. Mirrors the create route's registration gate:
// mainnet (Flare/Songbird) requires registration; testnets are exempt.
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const address = (searchParams.get("address") ?? "").toLowerCase();
  const chainId = Number(searchParams.get("chainId"));
  if (!address || !Number.isFinite(chainId)) {
    return NextResponse.json({ error: "address and chainId are required" }, { status: 400 });
  }
  const chain = getChain(chainId);
  if (!chain) {
    return NextResponse.json({ error: "unknown chainId" }, { status: 400 });
  }
  // Testnets have no on-chain reward data to check against, so they are not gated.
  if (!chain.mainnet) {
    return NextResponse.json({ registered: true, mainnet: false, chainName: chain.name });
  }
  const registered = await isRegisteredOnchain(address, chain.key);
  return NextResponse.json({ registered, mainnet: true, chainName: chain.name });
}
