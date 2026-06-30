import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionAddress } from "@/lib/session";
import { providerInputSchema, normalizeName } from "@/lib/validation";
import { publishFeedToRepo } from "@/lib/feed";
import { rateLimit } from "@/lib/rate-limit";
import { isRegisteredOnchain, resolveEntityListingAddress } from "@/lib/metrics";
import { getChain } from "@/lib/chains";
import { apiError } from "@/lib/api-error";

// POST /api/provider  -> create or update the authenticated provider's listing.
//
// Authorisation rule (the part that replaces PR review): the session address must be one of
// the addresses in the submission. You can only list addresses you have proven you control,
// and you can only edit a provider record that already contains your verified address.
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "submit", 10, 60_000); // 10/min/IP
  if (limited) return limited;
  const session = await getSessionAddress();
  if (!session) {
    return apiError("NOT_AUTHENTICATED", "not authenticated", 401);
  }

  const parsed = providerInputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;

  // The caller proves control of a network by signing with ANY of that network entity's five on-chain
  // role addresses, not only the delegation address stored on the listing. So:
  //  1. Normalize each submitted address to its CANONICAL listing address (if the submitted address is
  //     a role address of an entity on that network, use the entity's delegation address instead). The
  //     client may submit the connected role address; the listing always stores the canonical one.
  //  2. Likewise resolve the SESSION to the canonical address it controls per submitted network.
  //  3. A submitted (canonical) address is "controlled" when the session resolves to it.
  for (const a of input.addresses) {
    const chain = getChain(a.chainId);
    if (!chain?.mainnet) continue;
    const canon = await resolveEntityListingAddress(a.address, chain.key);
    if (canon) a.address = canon.listingAddress;
  }
  const controlled = new Set<string>([session.toLowerCase()]);
  for (const a of input.addresses) {
    const chain = getChain(a.chainId);
    if (!chain?.mainnet) continue;
    const resolved = await resolveEntityListingAddress(session, chain.key);
    if (resolved && resolved.listingAddress === a.address.toLowerCase()) {
      controlled.add(a.address.toLowerCase());
    }
  }

  // The session must control at least one submitted address (directly or via entity roles), otherwise
  // the caller is trying to manage a listing for a network they have not proven they control.
  const submittedAddresses = input.addresses.map((a) => a.address.toLowerCase());
  if (!submittedAddresses.some((a) => controlled.has(a))) {
    return NextResponse.json(
      { error: "your verified address must control one of the submitted addresses" },
      { status: 403 }
    );
  }

  // Registration gate: on mainnet networks (Flare/Songbird) the address must be a registered
  // on-chain FTSO entity. This keeps the registry to real providers. Testnets (Coston/Coston2)
  // have no on-chain reward data to check against, so they are exempt.
  for (const a of input.addresses) {
    const chain = getChain(a.chainId);
    if (chain?.mainnet && !(await isRegisteredOnchain(a.address, chain.key))) {
      // Coded + interpolation vars so the client can localize with the address/chain filled in.
      return NextResponse.json(
        {
          error: `address ${a.address} is not a registered FTSO entity on ${chain.name}. Only on-chain registered signal providers can list.`,
          code: "NOT_REGISTERED",
          vars: { address: a.address, chain: chain.name },
        },
        { status: 403 }
      );
    }
  }

  // Find any existing provider that holds the session address, whether it was a prior verified
  // claim OR an imported (not-yet-claimed) seed entry. Matching imported entries is what lets a
  // sign-in claim and edit an existing listing instead of creating a duplicate provider.
  const existingOwned = await prisma.providerAddress.findFirst({
    where: { address: session },
    select: { providerId: true },
  });

  // A logo is required. Accept it from this request (uploaded via /api/provider/logo before
  // publish) or fall back to one the provider already has (on update).
  const existingLogo = existingOwned
    ? await prisma.provider.findUnique({
        where: { id: existingOwned.providerId },
        select: { logoURI: true, logoPath: true },
      })
    : null;
  const hasLogo =
    !!input.logoURI || !!existingLogo?.logoURI || !!existingLogo?.logoPath;
  if (!hasLogo) {
    return apiError(
      "LOGO_REQUIRED",
      "a logo is required. Upload one before publishing your listing.",
      400
    );
  }

  // Name uniqueness: a provider name (normalised: lowercased, whitespace-collapsed) must not match
  // another provider's. The caller's OWN record is excluded so editing/keeping your name works.
  // A provider operating on multiple networks keeps one record, so this does not block them.
  const wantName = normalizeName(input.name);
  const sameName = await prisma.provider.findMany({
    select: { id: true, name: true },
  });
  const clash = sameName.find(
    (p) => normalizeName(p.name) === wantName && p.id !== existingOwned?.providerId
  );
  if (clash) {
    return NextResponse.json(
      {
        error: `A provider named "${clash.name}" already exists. If this is your other network, sign in with that listing and use "Link another network" instead of creating a new one.`,
        code: "NAME_TAKEN",
      },
      { status: 409 }
    );
  }

  // Guard each submitted address against being stolen from another provider. The SESSION
  // address may claim its own existing (incl. imported) record. Any OTHER submitted address
  // that already belongs to a different provider is rejected: you can only add addresses that
  // are unclaimed, and you can only take over a record via the session (signed) address.
  for (const a of input.addresses) {
    const claim = await prisma.providerAddress.findUnique({
      where: { chainId_address: { chainId: a.chainId, address: a.address } },
    });
    if (!claim) continue; // brand-new address, fine
    const isSessionAddr = a.address === session;
    const ownedByMe = claim.providerId === existingOwned?.providerId;
    // Allowed: my own record (any address), or the signed session address claiming its record.
    if (!ownedByMe && !isSessionAddr) {
      return NextResponse.json(
        {
          error: `address ${a.address} on chain ${a.chainId} belongs to another listing`,
          code: "ADDRESS_OTHER_LISTING",
        },
        { status: 409 }
      );
    }
  }

  // The session address is verified by definition; any other submitted address starts unverified
  // and must be signed for separately before it appears in the feed.
  const result = await prisma.$transaction(async (tx) => {
    // On claim/update, branding comes from the submitter and the provider becomes owner-owned
    // (source "submitted"), so it is no longer treated as an unclaimed imported seed.
    const branding = {
      name: input.name,
      description: input.description,
      url: input.url,
      privateNode: input.privateNode ?? null,
      algorithm: input.algorithm ?? null,
      source: "submitted",
      // A logo uploaded before publish goes through the SAME review window as any change: it is
      // stored as PENDING (held LOGO_REVIEW_DAYS, promoted by cron), not live. The /api/provider/logo
      // route commits it under assets/pending/, so its URL contains "/pending/"; persist it as pending
      // rather than as the live logoURI. On a plain edit (no new logo), leave the logo untouched.
      ...(input.logoURI && input.logoURI.includes("/pending/")
        ? {
            logoPendingURI: input.logoURI,
            logoPendingAt: new Date(),
            logoPendingSigner: session,
          }
        : input.logoURI
          ? { logoURI: input.logoURI, logoPath: null }
          : {}),
    };
    const provider = existingOwned
      ? await tx.provider.update({ where: { id: existingOwned.providerId }, data: branding })
      : await tx.provider.create({ data: branding });

    for (const a of input.addresses) {
      // Verify+list any submitted address the caller controls (the canonical listing address of a
      // network whose entity the session is a role of, or the session itself). Never silently verify
      // a network the caller has not proven control of.
      const isControlled = controlled.has(a.address.toLowerCase());
      await tx.providerAddress.upsert({
        where: { chainId_address: { chainId: a.chainId, address: a.address } },
        create: {
          providerId: provider.id,
          chainId: a.chainId,
          address: a.address,
          verified: isControlled,
          verifiedAt: isControlled ? new Date() : null,
          listed: isControlled,
        },
        update: {
          providerId: provider.id,
          ...(isControlled
            ? { verified: true, verifiedAt: new Date(), listed: true }
            : {}),
        },
      });
    }

    return provider;
  });

  // Keep the committed providerlist.json in the public repo in sync with this change.
  await publishFeedToRepo();

  return NextResponse.json({ id: result.id });
}
