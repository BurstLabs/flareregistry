import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionAddress } from "@/lib/session";
import { verifyChallenge } from "@/lib/auth";
import { isRegisteredOnchain } from "@/lib/metrics";
import { getChain } from "@/lib/chains";
import { publishFeedToRepo } from "@/lib/feed";
import { rateLimit } from "@/lib/rate-limit";

// POST /api/provider/link  -> attach a second network's address to the caller's existing listing.
//
// Flare and Songbird addresses aren't linked on-chain. To merge them onto one listing we require
// both signatures, so neither can be hijacked:
//   - A: the current session (the wallet already on the listing).
//   - B: a freshly signed challenge for the new address (in the body).
// The name must match the existing listing (cosmetic check; the two signatures are the real gate).
// B must pass the mainnet registration gate.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "submit", 10, 60_000);
  if (limited) return limited;

  // Address A: the existing, already-verified session.
  const sessionA = await getSessionAddress();
  if (!sessionA) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

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
      { error: verified.error ?? "could not verify the second address" },
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

  if (addressB === sessionA) {
    return NextResponse.json(
      { error: "the second address is the same as the one you are signed in with" },
      { status: 400 }
    );
  }

  // Registration gate for B on mainnet networks.
  const chainB = getChain(chainIdB);
  if (!chainB) {
    return NextResponse.json({ error: "unsupported network" }, { status: 400 });
  }
  if (chainB.mainnet && !(await isRegisteredOnchain(addressB))) {
    return NextResponse.json(
      {
        error: `address ${addressB} is not a registered FTSO entity on ${chainB.name}. Only on-chain registered signal providers can list.`,
      },
      { status: 403 }
    );
  }

  // Find the caller's existing listing (the provider holding the session address A).
  const ownedA = await prisma.providerAddress.findFirst({
    where: { address: sessionA },
    select: { providerId: true, provider: { select: { name: true } } },
  });
  if (!ownedA) {
    return NextResponse.json(
      { error: "you have no listing to link to; create one first" },
      { status: 404 }
    );
  }

  // Name-match confirmation: the entered name must equal the existing listing's name
  // (case- and surrounding-space-insensitive).
  const norm = (s: string) => s.trim().toLowerCase();
  if (norm(name) !== norm(ownedA.provider.name)) {
    return NextResponse.json(
      {
        error: `the name does not match your existing listing ("${ownedA.provider.name}"). Linking is only for the same provider.`,
      },
      { status: 409 }
    );
  }

  // If address B already belongs to a DIFFERENT provider, only allow the merge when that record
  // is an unclaimed import (no verified address). A claimed listing is never absorbed.
  const existingB = await prisma.providerAddress.findUnique({
    where: { chainId_address: { chainId: chainIdB, address: addressB } },
    select: {
      providerId: true,
      provider: { select: { addresses: { select: { verified: true } } } },
    },
  });
  if (existingB && existingB.providerId !== ownedA.providerId) {
    const otherIsClaimed = existingB.provider.addresses.some((a) => a.verified);
    if (otherIsClaimed) {
      return NextResponse.json(
        { error: `address ${addressB} already belongs to a claimed listing` },
        { status: 409 }
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    // Attach B (verified, listed) to the caller's provider. If B was an unclaimed import under a
    // different provider, move it over; clean up that now-empty imported provider.
    const orphanProviderId =
      existingB && existingB.providerId !== ownedA.providerId
        ? existingB.providerId
        : null;

    await tx.providerAddress.upsert({
      where: { chainId_address: { chainId: chainIdB, address: addressB } },
      create: {
        providerId: ownedA.providerId,
        chainId: chainIdB,
        address: addressB,
        verified: true,
        verifiedAt: new Date(),
        listed: true,
      },
      update: {
        providerId: ownedA.providerId,
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
  return NextResponse.json({ ok: true, linked: { chainId: chainIdB, address: addressB } });
}
