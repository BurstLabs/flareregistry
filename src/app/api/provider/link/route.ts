import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyChallenge } from "@/lib/auth";
import { isRegisteredOnchain, resolveEntityListingAddress, entityRoleAddresses } from "@/lib/metrics";
import { getChain } from "@/lib/chains";
import { publishFeedToRepo } from "@/lib/feed";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/provider/link  -> attach a network address to an existing, already-claimed listing.
//
// Flare and Songbird addresses aren't linked on-chain, and the two addresses are usually different
// wallets, so the owner often only has the NEW address's key on hand. We therefore authorize with a
// SINGLE signature from the new address (B), and gate it so a listing can't be hijacked:
//   - B's signature proves control of the new address.
//   - The target listing is matched BY NAME and must ALREADY have a verified owner (only a claimed
//     listing can have networks added; the first claim happens via /submit).
//   - For mainnet, B must be an on-chain registered FTSO entity on B's chain.
//   - B must not already be a verified part of a DIFFERENT listing.
// This also covers verifying an existing-but-unverified row (upsert flips it to verified).
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "submit", 10, 60_000);
  if (limited) return limited;

  const body = await req.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message : null;
  const signature = typeof body?.signature === "string" ? body.signature : null;
  const name = typeof body?.name === "string" ? body.name : null;
  if (!message || !signature || !name) {
    return NextResponse.json(
      { error: "message, signature, and name are required" },
      { status: 400 }
    );
  }

  // Address B: verify the signed challenge recovers to it (proves control of the new address).
  const verified = await verifyChallenge(message, signature);
  if (!verified.ok || !verified.address) {
    return NextResponse.json(
      { error: verified.error ?? "could not verify the address" },
      { status: 401 }
    );
  }
  const addressB = verified.address;
  // The chain B was signed for, taken from the SIWE message (the wallet attests to it).
  let chainIdB: number;
  try {
    const { SiweMessage } = await import("siwe");
    chainIdB = new SiweMessage(message).chainId;
  } catch {
    return NextResponse.json({ error: "malformed message" }, { status: 400 });
  }

  const chainB = getChain(chainIdB);
  if (!chainB) {
    return NextResponse.json({ error: "unsupported network" }, { status: 400 });
  }
  // Only mainnet networks (Flare/Songbird) are listable. Testnets have no ingested on-chain entity
  // data, so an address there cannot be verified - which previously let non-existent testnet addresses
  // be linked. Reject them outright.
  if (!chainB.mainnet) {
    return NextResponse.json(
      { error: `${chainB.name} is a testnet and cannot be listed.`, code: "TESTNET_NOT_SUPPORTED" },
      { status: 400 }
    );
  }
  // Registration gate: the address must be a registered on-chain FTSO entity on chain B.
  if (!(await isRegisteredOnchain(addressB, chainB.key))) {
    return NextResponse.json(
      {
        error: `address ${addressB} is not a registered FTSO entity on ${chainB.name}. Only on-chain registered signal providers can list.`,
        code: "NOT_REGISTERED",
      },
      { status: 403 }
    );
  }

  // The signer may use ANY of the entity's five on-chain role addresses (identity/submit/submit-sigs/
  // signing-policy/delegation) to prove control of this network. Get the full role set so we can match
  // the signer against whatever address the listing actually stores for this network (imported listings
  // may store any role, not the delegation address).
  const roles = chainB.mainnet ? await entityRoleAddresses(addressB, chainB.key) : [];

  // Find the target listing by name (shared normaliser, S14), and require it to already be claimed.
  const { normalizeName } = await import("@/lib/validation");
  const candidates = await prisma.provider.findMany({
    select: {
      id: true,
      name: true,
      addresses: { select: { chainId: true, address: true, verified: true } },
    },
  });
  const ownedA = candidates.find((p) => normalizeName(p.name) === normalizeName(name));
  if (!ownedA) {
    return NextResponse.json(
      { error: `no listing named "${name}" exists. Create one first via List your provider.` },
      { status: 404 }
    );
  }
  if (!ownedA.addresses.some((a) => a.verified)) {
    return NextResponse.json(
      {
        error: `the listing "${ownedA.name}" has no verified owner yet. Claim it first via List your provider.`,
      },
      { status: 409 }
    );
  }

  // Does an address ALREADY on this listing (on chain B) belong to the signer's entity? If so, this is
  // a "verify an existing row" action: verify THAT stored address (whatever role it is). Otherwise the
  // listing address to use is the entity's canonical (delegation) address, or the signer itself.
  const matchSet = new Set([addressB.toLowerCase(), ...roles]);
  const existingRow = ownedA.addresses.find(
    (a) => a.chainId === chainIdB && matchSet.has(a.address.toLowerCase())
  );
  const resolved = chainB.mainnet ? await resolveEntityListingAddress(addressB, chainB.key) : null;
  const listingAddress = existingRow?.address.toLowerCase() ?? resolved?.listingAddress ?? addressB;

  // Authorization (simplified per product decision). The listing must already be claimed (checked
  // above: it has a verified owner). To either VERIFY an existing row or LINK a new network, the signer
  // proves control of THAT network by signing with any of its entity's five on-chain role addresses
  // (the mainnet registration gate above already confirmed addressB is a registered entity on chain B).
  // We do NOT additionally require a verified-owner session. Trade-off accepted: someone controlling a
  // registered entity on the network being added could attach it to a claimed listing by name; this is
  // a deliberate simplification to avoid the two-signature / account-switch flow.
  const bAlreadyOnListing = !!existingRow;

  // If the canonical listing address already belongs to a DIFFERENT provider, only allow the merge
  // when that record is an unclaimed import (no verified address). A claimed listing is never absorbed.
  const existingB = await prisma.providerAddress.findUnique({
    where: { chainId_address: { chainId: chainIdB, address: listingAddress } },
    select: {
      providerId: true,
      provider: { select: { addresses: { select: { verified: true } } } },
    },
  });
  if (existingB && existingB.providerId !== ownedA.id) {
    const otherIsClaimed = existingB.provider.addresses.some((a) => a.verified);
    if (otherIsClaimed) {
      return NextResponse.json(
        { error: `address ${listingAddress} already belongs to a claimed listing` },
        { status: 409 }
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    // Attach the canonical listing address (verified, listed) to the caller's provider. If it was an
    // unclaimed import under a different provider, move it over; clean up that now-empty provider.
    const orphanProviderId =
      existingB && existingB.providerId !== ownedA.id
        ? existingB.providerId
        : null;

    await tx.providerAddress.upsert({
      where: { chainId_address: { chainId: chainIdB, address: listingAddress } },
      create: {
        providerId: ownedA.id,
        chainId: chainIdB,
        address: listingAddress,
        verified: true,
        verifiedAt: new Date(),
        listed: true,
      },
      update: {
        providerId: ownedA.id,
        verified: true,
        verifiedAt: new Date(),
        listed: true,
      },
    });

    if (orphanProviderId) {
      const remaining = await tx.providerAddress.count({
        where: { providerId: orphanProviderId },
      });
      if (remaining === 0) {
        await tx.provider.delete({ where: { id: orphanProviderId } });
      }
    }
  });

  await publishFeedToRepo();
  return NextResponse.json({ ok: true, linked: { chainId: chainIdB, address: listingAddress } });
}
