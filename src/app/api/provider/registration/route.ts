import { NextRequest, NextResponse } from "next/server";
import { isRegisteredOnchain } from "@/lib/metrics";
import { getChain } from "@/lib/chains";

export const dynamic = "force-dynamic";

// GET /api/provider/registration?address=0x..&chainId=14
// Lightweight read-only check of whether an address is a registered on-chain FTSO entity on the
// given chain, so the submit flow can warn an unregistered address up front (right after sign-in)
// instead of only when the listing is published. Mirrors the create route's registration gate:
// the address must be a registered FTSO entity on a supported network (Flare/Songbird).
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const address = (searchParams.get("address") ?? "").toLowerCase();
  const chainId = Number(searchParams.get("chainId"));
  if (!address || !Number.isFinite(chainId)) {
    return NextResponse.json({ error: "address and chainId are required" }, { status: 400 });
  }
  const chain = getChain(chainId);
  if (!chain) {
    // Only Flare/Songbird are supported; anything else (incl. testnets) is unknown here.
    return NextResponse.json({ error: "unknown chainId" }, { status: 400 });
  }
  const registered = await isRegisteredOnchain(address, chain.key);
  return NextResponse.json({ registered, mainnet: true, chainName: chain.name });
}
