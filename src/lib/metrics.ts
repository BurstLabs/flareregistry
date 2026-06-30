// Maps a Flare Registry provider (by its claimed addresses) to its on-chain FTSO entity and the
// metrics ingested from fsp-rewards. A provider matches an entity if any of its listed
// addresses equals one of the entity's five registered addresses.

import { prisma } from "./db";

/**
 * True if `address` is one of the registered on-chain FTSO entity addresses (any of the five
 * roles). Used to gate signup: only registered providers may list on Flare/Songbird.
 *
 * Pass `network` to require the match be on THAT specific chain. This is important: an address
 * registered on Flare must not pass the gate when being claimed as a Songbird listing (and vice
 * versa). Omit `network` only when an any-network match is genuinely intended.
 */
export async function isRegisteredOnchain(
  address: string,
  network?: string
): Promise<boolean> {
  const a = address.toLowerCase();
  const hit = await prisma.providerOnchain.findFirst({
    where: {
      ...(network ? { network } : {}),
      OR: [
        { voter: a },
        { delegationAddress: a },
        { submitAddress: a },
        { submitSignaturesAddress: a },
        { signingPolicyAddress: a },
      ],
    },
    select: { id: true },
  });
  return !!hit;
}

export interface ProviderMetrics {
  network: string;
  voter: string;
  feeBips: number | null;
  wNatWeight: string | null;
  wNatCappedWeight: string | null;
  feedCount: number | null;
  registered: boolean;
  goodStanding: boolean;
  lastEpoch: number;
  // Latest-epoch reward amounts (wei strings).
  feeReward: string | null;
  delegatorReward: string | null;
}

// Lowercased address -> entity, for the network(s) we ingest.
async function entityForAddresses(addresses: string[]): Promise<ProviderMetrics | null> {
  if (!addresses.length) return null;
  const addrs = addresses.map((a) => a.toLowerCase());

  const oc = await prisma.providerOnchain.findFirst({
    where: {
      OR: [
        { voter: { in: addrs } },
        { delegationAddress: { in: addrs } },
        { submitAddress: { in: addrs } },
        { submitSignaturesAddress: { in: addrs } },
        { signingPolicyAddress: { in: addrs } },
      ],
    },
  });
  if (!oc) return null;

  const latest = await prisma.providerMetricEpoch.findFirst({
    where: { network: oc.network, voter: oc.voter },
    orderBy: { epochId: "desc" },
  });

  return {
    network: oc.network,
    voter: oc.voter,
    feeBips: oc.feeBips,
    wNatWeight: oc.wNatWeight,
    wNatCappedWeight: oc.wNatCappedWeight,
    feedCount: oc.feedCount,
    registered: oc.registered,
    goodStanding: oc.goodStanding,
    lastEpoch: oc.lastEpochSeen,
    feeReward: latest?.feeReward ?? null,
    delegatorReward: latest?.delegatorReward ?? null,
  };
}

/** Metrics for one provider given all its addresses. Null if not matched on-chain. */
export async function metricsForProvider(addresses: string[]): Promise<ProviderMetrics | null> {
  return entityForAddresses(addresses);
}

// True if `signer` is authorized to act AS the provider whose listing addresses are `listingAddresses`.
// Accepts EITHER:
//   (a) a verified address on the listing (proved by signature in the registry), OR
//   (b) ANY of the five on-chain entity role addresses (voter, delegation, submit, submitSignatures,
//       signingPolicy) of any FTSO entity this provider matches on-chain.
// This mirrors the member-side rule (a member may sign with any of their five role addresses), so a
// provider is not forced to act only with the single address it happened to verify in the registry.
export async function signerControlsProvider(
  listingAddresses: { address: string; verified: boolean }[],
  signer: string
): Promise<boolean> {
  const s = signer.toLowerCase();
  // (a) Fast path: a verified listing address.
  if (listingAddresses.some((a) => a.address.toLowerCase() === s && a.verified)) return true;
  // (b) Any of the provider's matched on-chain entity role addresses. Match the entity by ANY of the
  // provider's listing addresses (verified or not, since the entity link is on-chain reality), then
  // check the signer against that entity's five role addresses.
  const addrs = listingAddresses.map((a) => a.address.toLowerCase());
  if (!addrs.length) return false;
  const entities = await prisma.providerOnchain.findMany({
    where: {
      OR: [
        { voter: { in: addrs } },
        { delegationAddress: { in: addrs } },
        { submitAddress: { in: addrs } },
        { submitSignaturesAddress: { in: addrs } },
        { signingPolicyAddress: { in: addrs } },
      ],
    },
    select: {
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });
  for (const e of entities) {
    const roles = [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ];
    if (roles.some((r) => r && r.toLowerCase() === s)) return true;
  }
  return false;
}

/**
 * Resolve a signer to the on-chain entity it is any of the five roles of, on a given network, and
 * return that entity's CANONICAL listing address for the network (its delegation address, falling
 * back to the voter). This lets a provider prove control of a network by signing with ANY of its five
 * role addresses, not only the one address stored on the listing. Returns null if the signer is not a
 * role of any entity on that network.
 */
export async function resolveEntityListingAddress(
  signer: string,
  network: string
): Promise<{ listingAddress: string; voter: string } | null> {
  const s = signer.toLowerCase();
  const oc = await prisma.providerOnchain.findFirst({
    where: {
      network,
      OR: [
        { voter: s },
        { delegationAddress: s },
        { submitAddress: s },
        { submitSignaturesAddress: s },
        { signingPolicyAddress: s },
      ],
    },
    select: { voter: true, delegationAddress: true },
  });
  if (!oc) return null;
  return {
    listingAddress: (oc.delegationAddress ?? oc.voter).toLowerCase(),
    voter: oc.voter.toLowerCase(),
  };
}

/**
 * All five on-chain role addresses (voter/identity, delegation, submit, submit-signatures,
 * signing-policy) of the entity that `signer` is a role of on `network`. Empty if not found. Used to
 * match a signer against whatever address a listing happens to store for that network (imported
 * listings may store any role, not the delegation address).
 */
export async function entityRoleAddresses(signer: string, network: string): Promise<string[]> {
  const s = signer.toLowerCase();
  const oc = await prisma.providerOnchain.findFirst({
    where: {
      network,
      OR: [
        { voter: s },
        { delegationAddress: s },
        { submitAddress: s },
        { submitSignaturesAddress: s },
        { signingPolicyAddress: s },
      ],
    },
    select: {
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });
  if (!oc) return [];
  return [
    oc.voter,
    oc.delegationAddress,
    oc.submitAddress,
    oc.submitSignaturesAddress,
    oc.signingPolicyAddress,
  ]
    .filter((a): a is string => !!a)
    .map((a) => a.toLowerCase());
}

/**
 * ALL five role addresses across every entity the signer is a role of. Used to find a listing by any
 * role address regardless of which role the listing happens to store (imported listings may store the
 * submit, identity, etc. address rather than delegation). Empty if the signer is not a known role.
 * NOTE: returns the full role set on purpose - matching only the delegation address misses listings
 * that stored a different role, which was a recurring lookup bug.
 */
export async function listingAddressesForSigner(signer: string): Promise<string[]> {
  const s = signer.toLowerCase();
  const entities = await prisma.providerOnchain.findMany({
    where: {
      OR: [
        { voter: s },
        { delegationAddress: s },
        { submitAddress: s },
        { submitSignaturesAddress: s },
        { signingPolicyAddress: s },
      ],
    },
    select: {
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });
  const out = new Set<string>();
  for (const e of entities) {
    for (const a of [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ]) {
      if (a) out.add(a.toLowerCase());
    }
  }
  return [...out];
}

/**
 * Batch: map providerId -> metrics for a list of providers (each with its addresses). One
 * query per provider; fine for a directory page of ~150 rows, can be optimised later.
 */
export async function metricsForProviders(
  providers: { id: string; addresses: { address: string }[] }[]
): Promise<Map<string, ProviderMetrics>> {
  const out = new Map<string, ProviderMetrics>();
  await Promise.all(
    providers.map(async (p) => {
      const m = await entityForAddresses(p.addresses.map((a) => a.address));
      if (m) out.set(p.id, m);
    })
  );
  return out;
}

// Display helpers.
export function formatFee(feeBips: number | null): string | null {
  return feeBips == null ? null : `${(feeBips / 100).toFixed(0)}%`;
}

/** wei string -> compact human number (e.g. "12.3M"). */
export function formatWeiCompact(wei: string | null): string | null {
  if (!wei) return null;
  try {
    const whole = Number(BigInt(wei) / 10n ** 18n);
    if (whole >= 1e9) return `${(whole / 1e9).toFixed(1)}B`;
    if (whole >= 1e6) return `${(whole / 1e6).toFixed(1)}M`;
    if (whole >= 1e3) return `${(whole / 1e3).toFixed(1)}K`;
    return `${whole}`;
  } catch {
    return null;
  }
}
