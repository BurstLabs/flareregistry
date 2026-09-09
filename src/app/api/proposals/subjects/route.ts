import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/proposals/subjects -> every entity a Management Group proposal can name, with the
// on-chain identity address the proposal should carry.
//
// WHY THIS EXISTS AT ALL. A proposal names its subject by address, and until now that address was
// typed by hand into a textarea. Addresses differ in the middle and a transposition looks like
// nothing, so a slip names the WRONG provider in a public governance action, and the mistake is
// discovered only after 100 FLR has been burned on a proposal that cannot be cancelled. Picking a
// subject by name and letting us supply the address removes the entire class of error.
//
// DRIVEN OFF THE CHAIN, NOT OFF OUR REGISTRY, and the difference is not academic. The first version
// of this listed the 108 providers with a listing here and missed the other 121 entities entirely,
// including Rotko and Sceptre, who between them are the subjects of both proposals currently open.
// A form that cannot name the thing the group is actually voting on is worse than no form. The
// registry supplies a NAME where it has one; the chain decides who exists.
//
// NOT A SECURITY BOUNDARY and it needs none: entity addresses and provider names are already public
// on the directory and in the feed. Eligibility to submit is enforced by the contract, which takes
// a proposal only from a current Management Group member.
export async function GET() {
  const [entities, addresses] = await Promise.all([
    prisma.providerOnchain.findMany({
      // FLARE ONLY. The Management Group and its proposals are Flare's, and every existing proposal
      // names a Flare identity. Including Songbird put 79 extra entities in the list and made 48
      // operator names appear TWICE under different addresses, which on a form whose whole job is
      // naming the right party is the error it exists to prevent.
      where: { network: "flare" },
      select: {
        network: true,
        voter: true,
        delegationAddress: true,
        submitAddress: true,
        submitSignaturesAddress: true,
        signingPolicyAddress: true,
      },
    }),
    prisma.providerAddress.findMany({
      select: { address: true, provider: { select: { name: true, archivedAt: true } } },
    }),
  ]);

  const nameByRole = new Map<string, string>();
  for (const a of addresses) {
    if (a.provider.archivedAt) continue;
    nameByRole.set(a.address.toLowerCase(), a.provider.name);
  }

  // One row per entity, keyed by the voter, which is the address every existing proposal names.
  // A name is found through ANY of the five roles, since a listing is filed under whichever role
  // its owner claimed with.
  const seen = new Set<string>();
  const subjects: { name: string; address: string; network: string; listed: boolean }[] = [];
  for (const e of entities) {
    const voter = e.voter.toLowerCase();
    if (seen.has(voter)) continue;
    seen.add(voter);
    const roles = [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress]
      .filter((r): r is string => !!r)
      .map((r) => r.toLowerCase());
    const named = roles.map((r) => nameByRole.get(r)).find(Boolean) ?? null;
    // A listing whose name is its own address tells a reader nothing the address does not, so it
    // counts as unnamed and sorts with the rest of the anonymous entities.
    const real = named && !/^0x[0-9a-f]{40}$/i.test(named.trim()) ? named : null;
    subjects.push({
      name: real ?? voter,
      address: voter,
      network: e.network,
      listed: !!real,
    });
  }

  // Named first and alphabetical, so the list reads as operators; the address-only entities follow.
  subjects.sort((a, b) => {
    if (a.listed !== b.listed) return a.listed ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return NextResponse.json({ subjects, count: subjects.length });
}
