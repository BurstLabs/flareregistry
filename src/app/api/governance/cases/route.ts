import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// GET /api/governance/cases
// Public, read-only index of all flag cases for the governance records list, so archived/decided
// flags stay accessible even after they are hidden from a (now-qualified) provider's page. Includes
// live cases too, so the page is a complete record. Newest activity first.
export const dynamic = "force-dynamic";

export async function GET() {
  const cases = await prisma.providerFlagCase.findMany({
    orderBy: [{ decidedAt: "desc" }, { openedAt: "desc" }],
    select: {
      id: true,
      state: true,
      openedAt: true,
      decidedAt: true,
      provider: { select: { name: true, addresses: { select: { address: true }, take: 1 } } },
    },
  });

  const records = cases.map((c) => ({
    caseId: c.id,
    state: c.state,
    providerName: c.provider.name,
    detailAddress: c.provider.addresses[0]?.address ?? "",
    at: (c.decidedAt ?? c.openedAt).toISOString(),
  }));

  return NextResponse.json(
    { records },
    { headers: { "access-control-allow-origin": "*", "cache-control": "public, max-age=30" } }
  );
}
