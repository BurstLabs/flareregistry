import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireAdmin } from "@/lib/admin";

export const dynamic = "force-dynamic";

// GET /api/admin/mg-members -> current Management Group members, named where a listing names them.
//
// For the co-initiator control on the Conduct tab. That field decides whose signature a point counts
// as, and therefore how close a case is to the four it needs, so picking the wrong one is not a
// typo that shows up later: it silently attributes an accusation to a provider who did not make it.
// A raw address box invites exactly that, since the addresses differ in the middle and a
// transposition looks like nothing.
//
// NAMES COME FROM THE FIVE-ROLE JOIN, not from the voter address alone. A listing is filed under
// whichever role its owner claimed with, usually the delegation address, so matching only on voter
// leaves most members showing as unnamed and hands the operator back the problem this is solving.
//
// Membership is read from ProviderOnchain.managementGroup, which the hourly sync refreshes from
// PollingManagementGroup. Nothing here is a security boundary, and it is admin-gated anyway;
// membership is public on-chain state.
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const ents = await prisma.providerOnchain.findMany({
    where: { managementGroup: true },
    select: {
      network: true,
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });

  const addrs = await prisma.providerAddress.findMany({
    select: { address: true, provider: { select: { name: true, source: true } } },
  });
  const byAddr = new Map(addrs.map((a) => [a.address.toLowerCase(), a.provider]));

  // One row per member ENTITY. An operator running on both chains appears once, keyed by the voter
  // the conduct route actually stores.
  const seen = new Set<string>();
  const members: { voter: string; name: string | null; network: string }[] = [];
  for (const e of ents) {
    const v = e.voter.toLowerCase();
    if (seen.has(v)) continue;
    seen.add(v);
    const roles = [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ]
      .filter((r): r is string => !!r)
      .map((r) => r.toLowerCase());
    const listed = roles.map((r) => byAddr.get(r)).find(Boolean);
    // A listing whose name is its own address is the on-chain tier, which is no more informative
    // than the address already shown, so it counts as unnamed rather than repeating the hex twice.
    const listedName =
      listed && !/^0x[0-9a-f]{40}$/i.test(listed.name.trim()) ? listed.name : null;
    members.push({ voter: v, name: listedName, network: e.network });
  }

  // Named first and alphabetical, so the list reads as people rather than as hex.
  members.sort((a, b) => {
    if (!!a.name !== !!b.name) return a.name ? -1 : 1;
    return (a.name ?? a.voter).localeCompare(b.name ?? b.voter);
  });

  return NextResponse.json({ members, count: members.length });
}
