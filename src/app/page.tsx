import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chains";
import { metricsForProviders, formatWeiCompact } from "@/lib/metrics";
import { qualifyProviders, latchedQualifiedByAddresses } from "@/lib/qualification";
import { isHeldNewProvider } from "@/lib/governance";
import { DirectoryClient, type CardProvider } from "@/components/directory-client";

// Public directory. Fetches + computes here, hands a serializable shape to the client component.
export const dynamic = "force-dynamic";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "";

function cardLogo(logoPath: string | null, logoURI: string | null): string {
  if (logoPath)
    return `${PUBLIC_BASE_URL}${logoPath.startsWith("/") ? "" : "/"}${logoPath}`;
  return logoURI ?? "/logo-placeholder.png";
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ show?: string }>;
}) {
  const showAll = (await searchParams)?.show === "all";

  const all = await prisma.provider.findMany({
    // Exclude archived (departed/unmatched) providers from the directory - they live only on the
    // read-only archive endpoint. Without this, archived legacy imports (e.g. SAKURA) still showed.
    where: {
      archivedAt: null,
      OR: [{ addresses: { some: { verified: true } } }, { source: "imported" }],
    },
    include: { addresses: true },
    orderBy: { name: "asc" },
  });

  const latched = await latchedQualifiedByAddresses(
    all.map((p) => ({ id: p.id, addresses: p.addresses.map((a) => a.address) }))
  );
  const qualifications = await qualifyProviders(all);

  const { governanceByProvider } = await import("@/lib/governance");
  const govByProvider = await governanceByProvider();
  const isSuspended = (id: string) => govByProvider.get(id)?.suspended ?? false;

  // New-provider hold: a provider inside its 30-day new-provider window (anchored on the signed-
  // claim date) is treated exactly like a not-yet-listed provider even if it already qualifies,
  // so a pre-warmed on-chain entity cannot register and instantly show as Qualified/listed before
  // the Management Group can react. Not MG-gated: it lists automatically once the window elapses.
  // A live governance case (pending or under review) also holds it, independent of the clock, so a
  // case opened late in the window keeps it unlisted through the vote instead of auto-listing at
  // day 30 mid-vote (matches feed.ts).
  const now = new Date();
  const createdById = new Map(all.map((p) => [p.id, p.createdAt]));
  const held = (id: string) => {
    const c = createdById.get(id);
    const g = govByProvider.get(id);
    return (c ? isHeldNewProvider(c, now) : false) || !!g?.underReview || !!g?.pending;
  };
  const isQualified = (id: string) => (latched.get(id) ?? false) && !held(id);
  // True if any qualification check passes. Zero passes = stale name, hidden even from "show all".
  const hasAnyPass = (id: string) =>
    (qualifications.get(id)?.checks ?? []).some((c) => c.status === "pass");

  const listable = all.filter((p) => hasAnyPass(p.id));
  // Qualified count and the default view both exclude suspended providers. The "show all" view
  // still shows them (with a Suspended chip) so the record stays public.
  const qualifiedCount = listable.filter((p) => isQualified(p.id) && !isSuspended(p.id)).length;
  const shown = showAll
    ? listable
    : listable.filter((p) => isQualified(p.id) && !isSuspended(p.id));

  const metrics = await metricsForProviders(shown);
  const { managementGroupByProvider } = await import("@/lib/management-group");
  const mgByProvider = await managementGroupByProvider();

  // Batch-load per-validator stats (fee/connected) for every node across all shown providers in one
  // query, then map per provider for the card validator list.
  const allNodeIds = Array.from(new Set([...metrics.values()].flatMap((m) => m.nodeIds)));
  const validatorRows = allNodeIds.length
    ? await prisma.providerValidator.findMany({ where: { nodeId: { in: allNodeIds } } })
    : [];
  const validatorByNode = new Map(validatorRows.map((v) => [v.nodeId, v]));

  const cards: CardProvider[] = shown.map((p) => {
    const m = metrics.get(p.id);
    const q = qualifications.get(p.id);
    return {
      id: p.id,
      name: p.name,
      description: p.description,
      url: p.url,
      logo: cardLogo(p.logoPath, p.logoURI),
      qualified: isQualified(p.id),
      registered: !!m?.registered,
      managementGroup: mgByProvider.get(p.id) ?? false,
      verified: p.source !== "imported",
      governance: govByProvider.get(p.id)
        ? {
            pending: govByProvider.get(p.id)!.pending,
            underReview: govByProvider.get(p.id)!.underReview,
            suspended: govByProvider.get(p.id)!.suspended,
            caseId: govByProvider.get(p.id)!.caseId,
          }
        : null,
      votePower: formatWeiCompact(m?.wNatWeight ?? null),
      reward: formatWeiCompact(m?.delegatorReward ?? null),
      rewardEpoch: m?.lastEpoch ?? null,
      validators: (m?.nodeIds ?? []).map((id) => {
        const v = validatorByNode.get(id);
        return {
          nodeId: id,
          feePercent: v?.feePercent ?? null,
          connected: v?.connected ?? null,
        };
      }),
      checks: (q?.checks ?? []).map((c) => ({
        key: c.key,
        label: c.label,
        status: c.status,
        detail: c.detail,
      })),
      chains: Array.from(
        new Set(p.addresses.map((a) => getChain(a.chainId)?.name ?? `chain ${a.chainId}`))
      ),
      privateNode: !!p.privateNode,
      algorithm: p.algorithm,
      detailAddress: p.addresses[0]?.address ?? "",
    };
  });

  return (
    <DirectoryClient
      providers={cards}
      total={listable.length}
      qualifiedCount={qualifiedCount}
      showAll={showAll}
    />
  );
}
