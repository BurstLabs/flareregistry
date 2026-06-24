// Maps a Flare Registry provider (by its claimed addresses) to its on-chain FTSO entity and the
// metrics ingested from fsp-rewards. A provider matches an entity if any of its listed
// addresses equals one of the entity's five registered addresses.

import { prisma } from "./db";

/**
 * True if `address` is one of the registered on-chain FTSO entity addresses (any of the five
 * roles) on a mainnet network. Used to gate signup: only registered providers may list on
 * Flare/Songbird. Returns true regardless of network (caller decides which networks to enforce).
 */
export async function isRegisteredOnchain(address: string): Promise<boolean> {
  const a = address.toLowerCase();
  const hit = await prisma.providerOnchain.findFirst({
    where: {
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
