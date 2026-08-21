import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { PUBLIC_CASE_WHERE } from "@/lib/governance";

// GET /api/governance/cases
// Public, read-only index of all flag cases for the governance records list, so archived/decided
// flags stay accessible even after they are hidden from a (now-qualified) provider's page. Includes
// live cases too, so the page is a complete record. Newest activity first.
export const dynamic = "force-dynamic";

export async function GET() {
  const cases = await prisma.providerFlagCase.findMany({
    // Sealed CONDUCT cases are excluded. FLAG cases are unaffected: they remain public from the
    // moment they are raised, which §7 of the spec requires.
    where: PUBLIC_CASE_WHERE,
    orderBy: [{ decidedAt: "desc" }, { openedAt: "desc" }],
    select: {
      id: true,
      // KIND IS EXPOSED so the reader can be told which mechanism decided this. The two share this
      // table and nothing else: a flag can suspend a new provider, a conduct finding cannot suspend
      // anyone and has no appeal. Listing them under one heading would describe a finding as a flag,
      // which is not a labelling nicety when the subject is a named business.
      kind: true,
      state: true,
      openedAt: true,
      decidedAt: true,
      provider: { select: { name: true, addresses: { select: { address: true }, take: 1 } } },
    },
  });

  const records = cases.map((c) => ({
    caseId: c.id,
    kind: c.kind,
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
