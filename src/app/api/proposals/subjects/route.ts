import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/proposals/subjects -> every provider that can be named in a Management Group proposal,
// with the on-chain identity address a proposal should carry.
//
// WHY THIS EXISTS AT ALL. A proposal names its subject by address, and until now that address was
// typed by hand into a textarea. Addresses differ in the middle and a transposition looks like
// nothing, so a slip names the WRONG provider in a public governance action, and the mistake is
// discovered only after 100 FLR has been burned on a proposal that cannot be cancelled. Picking a
// provider by name and letting us supply the address removes the entire class of error.
//
// NOT A SECURITY BOUNDARY and it needs none: provider names and their on-chain identity addresses
// are already public, on the directory and in the feed. The eligibility to actually submit is
// enforced by the contract, which accepts a proposal only from a current Management Group member.
//
// THE IDENTITY (voter) ADDRESS, not the listing's claimed address. A listing is filed under
// whichever of the five roles its owner claimed with, usually the delegation address, but a
// proposal is about the ENTITY, and every existing proposal names the voter.
export async function GET() {
  const providers = await prisma.provider.findMany({
    where: { archivedAt: null },
    select: { name: true, addresses: { select: { address: true } } },
  });

  const entities = await prisma.providerOnchain.findMany({
    select: {
      network: true,
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });

  // Any of the five roles maps back to the entity, matching how the rest of this codebase resolves
  // a listing to its on-chain identity.
  const byRole = new Map<string, { voter: string; network: string }>();
  for (const e of entities) {
    for (const r of [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress]) {
      if (r) byRole.set(r.toLowerCase(), { voter: e.voter.toLowerCase(), network: e.network });
    }
  }

  const seen = new Set<string>();
  const subjects: { name: string; address: string; network: string }[] = [];
  for (const p of providers) {
    for (const a of p.addresses) {
      const hit = byRole.get(a.address.toLowerCase());
      if (!hit || seen.has(hit.voter)) continue;
      seen.add(hit.voter);
      subjects.push({ name: p.name, address: hit.voter, network: hit.network });
      break;
    }
  }

  // Named first, then alphabetical, so the list reads as operators rather than as hex. A listing
  // whose name is its own address is the chain-only tier and sorts last.
  subjects.sort((a, b) => {
    const ax = /^0x[0-9a-f]{40}$/i.test(a.name.trim());
    const bx = /^0x[0-9a-f]{40}$/i.test(b.name.trim());
    if (ax !== bx) return ax ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return NextResponse.json({ subjects, count: subjects.length });
}
