import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chains";
import { metricsForProvider, formatWeiCompact, listingAddressesForSigner } from "@/lib/metrics";
import { qualifyProviders, latchedQualifiedByAddresses } from "@/lib/qualification";
import { isHeldNewProvider, inNewProviderWindow, NEW_PROVIDER_WINDOW_DAYS } from "@/lib/governance";
import { ProviderDetailClient, type DetailData } from "@/components/provider-detail-client";

export const dynamic = "force-dynamic";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "";

function cardLogo(logoPath: string | null, logoURI: string | null): string {
  if (logoPath) return `${PUBLIC_BASE_URL}${logoPath.startsWith("/") ? "" : "/"}${logoPath}`;
  return logoURI ?? "/logo-placeholder.png";
}

export default async function ProviderDetail({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const addr = (await params).address.toLowerCase();

  // Find the provider that owns this address. Resolve by a stored listing address OR by any of the
  // entity's five on-chain role addresses, so a link shared with a non-delegation role address (e.g.
  // after claiming with a submit address) still resolves to the listing.
  let owned = await prisma.providerAddress.findFirst({
    where: { address: addr },
    include: { provider: { include: { addresses: true } } },
  });
  if (!owned) {
    const canon = await listingAddressesForSigner(addr);
    if (canon.length) {
      owned = await prisma.providerAddress.findFirst({
        where: { address: { in: canon } },
        include: { provider: { include: { addresses: true } } },
      });
    }
  }
  if (!owned) notFound();
  const p = owned.provider;
  // Archived (departed/unmatched) providers are not part of the live registry - their detail page is
  // gone (they remain only on the read-only archive endpoint). 404 so they don't render as live.
  if (p.archivedAt) notFound();
  const addresses = p.addresses.map((a) => a.address);

  const [metrics, qualMap, latchedMap] = await Promise.all([
    metricsForProvider(addresses),
    qualifyProviders([{ id: p.id, url: p.url, addresses: p.addresses.map((a) => ({ address: a.address })) }]),
    latchedQualifiedByAddresses([{ id: p.id, addresses }]),
  ]);
  const qual = qualMap.get(p.id);

  // Per-epoch history for the matched entity (for the trend).
  const historyRows = metrics
    ? await prisma.providerMetricEpoch.findMany({
        where: { network: metrics.network, voter: metrics.voter },
        orderBy: { epochId: "asc" },
      })
    : [];

  // Per-validator stats (fee/uptime/connected) for this entity's node ids, joined by nodeId.
  const validatorInfo =
    metrics && metrics.nodeIds.length
      ? await (await import("@/lib/validators")).validatorsForNodeIds(metrics.network, metrics.nodeIds)
      : new Map();
  const validators = (metrics?.nodeIds ?? []).map((id) => {
    const v = validatorInfo.get(id);
    return {
      nodeId: id,
      feePercent: v?.feePercent ?? null,
      uptimePercent: v?.uptimePercent ?? null,
      connected: v?.connected ?? null,
    };
  });

  // The full registered on-chain entity (all five role addresses) for each network this provider
  // is matched on, so the detail page can show the entity's complete on-chain identity.
  const lowerAddrs = addresses.map((a) => a.toLowerCase());
  const entities = await prisma.providerOnchain.findMany({
    where: {
      OR: [
        { voter: { in: lowerAddrs } },
        { delegationAddress: { in: lowerAddrs } },
        { submitAddress: { in: lowerAddrs } },
        { submitSignaturesAddress: { in: lowerAddrs } },
        { signingPolicyAddress: { in: lowerAddrs } },
      ],
    },
  });
  const NETWORK_LABEL: Record<string, string> = { flare: "Flare", songbird: "Songbird" };
  const entityAddresses = entities.map((e) => ({
    network: NETWORK_LABEL[e.network] ?? e.network,
    // roleKey is a stable identifier translated client-side (detail.role.*); role keeps the English
    // term as a fallback for any client that does not translate.
    roles: [
      { roleKey: "identity", role: "Identity", address: e.voter },
      { roleKey: "submit", role: "Submit", address: e.submitAddress },
      { roleKey: "submitSignatures", role: "Submit signatures", address: e.submitSignaturesAddress },
      { roleKey: "signingPolicy", role: "Signing policy", address: e.signingPolicyAddress },
      { roleKey: "delegation", role: "Delegation", address: e.delegationAddress },
    ].filter((r): r is { roleKey: string; role: string; address: string } => !!r.address),
  }));

  const gov = (await (await import("@/lib/governance")).governanceByProvider()).get(p.id) ?? null;

  // New-provider hold, decomposed into its two independent axes so the flag/badge logic stays clear:
  //  - heldWindow: the raw 30-day new-provider clock (createdAt-anchored), regardless of criteria.
  //  - liveCase:   a pending or under-review governance case (holds listing past the clock).
  // meetsCriteria is the on-chain qualification latch. A provider is effectively Qualified/listed
  // only when it meets criteria AND is not held by either axis (mirrors feed.ts and the directory).
  const nowDate = new Date();
  const meetsCriteria = latchedMap.get(p.id) ?? false;
  const heldWindow = isHeldNewProvider(p.createdAt, nowDate);
  const liveCase = !!gov?.underReview || !!gov?.pending;
  const held = meetsCriteria && (heldWindow || liveCase);
  // heldUntil (the "lists on {date}" note) reflects only the clock; a live case has no fixed end
  // date, so we only surface the auto-list date when the sole reason for the hold is the window.
  const heldUntil =
    held && heldWindow && !liveCase
      ? new Date(p.createdAt.getTime() + NEW_PROVIDER_WINDOW_DAYS * 86_400_000).toISOString()
      : null;

  const data: DetailData = {
    name: p.name,
    description: p.description,
    url: p.url,
    logo: cardLogo(p.logoPath, p.logoURI),
    verified: p.source !== "imported",
    registered: !!metrics?.registered,
    managementGroup: (await (await import("@/lib/management-group")).managementGroupByProvider()).get(p.id) ?? false,
    governance: gov,
    pastCases: (await (await import("@/lib/governance")).pastCasesByProvider()).get(p.id) ?? [],
    providerId: p.id,
    hasLogo: !!p.logoURI,
    // Flaggable: matched on-chain, not yet EFFECTIVELY qualified (a provider that meets every
    // criterion but is still inside its 30-day hold is not listed yet and IS still flaggable, which
    // is the whole point of the review window), inside the new-provider window, not already flagged,
    // and not suspended. Gate on the raw window (`heldWindow`) so a held-but-criteria-meeting
    // provider (e.g. a pre-warmed entrant) stays flaggable instead of vanishing the moment it latches.
    flaggable:
      entities.length > 0 &&
      !(meetsCriteria && !heldWindow) &&
      !p.flaggedOnce &&
      !p.suspended &&
      inNewProviderWindow(p.createdAt, nowDate),
    // New-provider hold: qualifying providers still inside their 30-day window (or with a live case)
    // are not shown as Qualified/listed yet (same effect as listed:false), matching the feed and the
    // directory. Not MG-gated; auto-lists once the window elapses and no case is open.
    qualified: meetsCriteria && !held,
    heldUntil,
    network: metrics?.network ?? null,
    votePower: formatWeiCompact(metrics?.wNatWeight ?? null),
    votePowerCapped: formatWeiCompact(metrics?.wNatCappedWeight ?? null),
    feedCount: metrics?.feedCount ?? null,
    reward: formatWeiCompact(metrics?.delegatorReward ?? null),
    stakerReward: formatWeiCompact(metrics?.stakerReward ?? null),
    rewardEpoch: metrics?.lastEpoch ?? null,
    validators,
    privateNode: !!p.privateNode,
    algorithm: p.algorithm,
    checks: (qual?.checks ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      status: c.status,
      detail: c.detail,
    })),
    addresses: p.addresses.map((a) => ({
      chainId: a.chainId,
      chain: getChain(a.chainId)?.name ?? `chain ${a.chainId}`,
      address: a.address,
      verified: a.verified,
      testnet: getChain(a.chainId)?.mainnet === false,
    })),
    entityAddresses,
    history: historyRows.map((r) => ({
      epoch: r.epochId,
      feeBips: r.feeBips,
      votePower: r.wNatWeight,
      delegatorReward: r.delegatorReward,
      feeReward: r.feeReward,
      votePowerLabel: formatWeiCompact(r.wNatWeight),
      rewardLabel: formatWeiCompact(r.delegatorReward),
    })),
  };

  return <ProviderDetailClient data={data} />;
}
