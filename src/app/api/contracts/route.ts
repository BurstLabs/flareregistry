import { NextResponse } from "next/server";
import { getProviderContracts } from "@/lib/contract-registry";

// Cache the resolved response at the edge for an hour; the underlying addresses change only on a
// (rare) protocol upgrade, and the lib already caches per-network for the same window.
export const revalidate = 3600;

// GET /api/contracts
// Returns Flare's on-chain FTSO protocol contract addresses per network (Flare, Songbird), resolved
// live from the fixed Flare Contract Registry. Read-only, public. These are Flare protocol contracts,
// not flareregistry contracts - surfaced for providers who register/manage on-chain directly.
export async function GET() {
  try {
    const networks = await getProviderContracts(Date.now());
    if (!networks.length) {
      return NextResponse.json({ error: "unavailable" }, { status: 503 });
    }
    return NextResponse.json({ networks });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
