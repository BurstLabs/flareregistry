import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSessionAddress } from "@/lib/session";
import { providerInputSchema, normalizeName } from "@/lib/validation";
import { publishFeedToRepo } from "@/lib/feed";
import { rateLimit } from "@/lib/rate-limit";
import { isRegisteredOnchain, resolveEntityListingAddress, entityRoleAddresses } from "@/lib/metrics";
import { getChain } from "@/lib/chains";
import { isAssetLogoURI } from "@/lib/logos";
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

  // A logoURI is only trusted if it points at our own assets repo, i.e. it came from an actual
  // upload through /api/provider/logo (which validates the PNG and stages it for review). Reject an
  // arbitrary host so a caller cannot set a live logo that skips PNG validation and the review window.
  if (input.logoURI && !isAssetLogoURI(input.logoURI)) {
    return apiError("LOGO_URI_INVALID", "logoURI must be an uploaded asset URL", 400);
  }

  // The caller proves control of a network by signing with ANY of that network entity's five on-chain
  // role addresses, not only the address stored on the listing. So, per submitted address, normalize it
  // to the address that should appear on the listing:
  //  - If one of the SIGNER's role addresses for that network is ALREADY a row on an existing listing,
  //    use THAT stored address (imported listings may store any role, not delegation - matching the
  //    stored row avoids creating a duplicate delegation row and re-verifies the existing one).
  //  - Otherwise fall back to the entity's canonical (delegation) address.
  // Then a network is "controlled" when the SESSION resolves (via any of its roles) to that address.
  for (const a of input.addresses) {
    const chain = getChain(a.chainId);
    if (!chain?.mainnet) continue;
    const roles = await entityRoleAddresses(a.address, chain.key);
    if (roles.length) {
      const existing = await prisma.providerAddress.findFirst({
        where: { chainId: a.chainId, address: { in: roles } },
        select: { address: true },
      });
      const canon = await resolveEntityListingAddress(a.address, chain.key);
      a.address = (existing?.address ?? canon?.listingAddress ?? a.address).toLowerCase();
    }
  }
  const controlled = new Set<string>([session.toLowerCase()]);
  for (const a of input.addresses) {
    const chain = getChain(a.chainId);
    if (!chain?.mainnet) continue;
    // The session controls this network if any of the session's role addresses for it matches the
    // (normalized) submitted address - i.e. the session and the address belong to the same entity.
    const sessionRoles = await entityRoleAddresses(session, chain.key);
    if (sessionRoles.includes(a.address.toLowerCase())) {
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

  // Only mainnet networks (Flare/Songbird) are listable. Testnets have no ingested on-chain entity
  // data and cannot be verified, so they are rejected.
  for (const a of input.addresses) {
    const chain = getChain(a.chainId);
    if (chain && !chain.mainnet) {
      return NextResponse.json(
        { error: `${chain.name} is a testnet and cannot be listed.`, code: "TESTNET_NOT_SUPPORTED" },
        { status: 400 }
      );
    }
  }
  // Registration gate: on mainnet the address must be a registered on-chain FTSO entity.
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

  // Find any existing provider the caller controls, whether it was a prior verified claim OR an
  // imported (not-yet-claimed) seed entry. Matching imported entries is what lets a sign-in claim and
  // edit an existing listing instead of creating a duplicate. The caller may have signed with a role
  // address that is NOT a stored listing row, so match by the CONTROLLED canonical addresses (which
  // include the session and any submitted network whose entity the session is a role of), not just
  // the raw session address.
  const existingOwned = await prisma.providerAddress.findFirst({
    where: { address: { in: [...controlled] } },
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
    // "Mine" = the caller controls this (canonical) address (session itself, or a network whose
    // entity the session is a role of), or it already belongs to the caller's existing record.
    const isControlledAddr = controlled.has(a.address.toLowerCase());
    const ownedByMe = claim.providerId === existingOwned?.providerId;
    if (!ownedByMe && !isControlledAddr) {
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
      singleEntity: input.singleEntity ?? null,
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

  // Return a canonical listing address the caller controls, so the client can redirect to a working
  // /provider/<address> page (the connected address may be a role address that is not a listing row).
  const redirectAddress =
    input.addresses.find((a) => controlled.has(a.address.toLowerCase()))?.address ??
    input.addresses[0]?.address;
  return NextResponse.json({ id: result.id, address: redirectAddress });
}
