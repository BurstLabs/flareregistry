import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chains";
import { metricsForProviders, formatFee, formatWeiCompact } from "@/lib/metrics";
import { qualifyProviders, latchedQualifiedByAddresses } from "@/lib/qualification";
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

  const isQualified = (id: string) => latched.get(id) ?? false;
  // True if any qualification check passes. Zero passes = stale name, hidden even from "show all".
  const hasAnyPass = (id: string) =>
    (qualifications.get(id)?.checks ?? []).some((c) => c.status === "pass");

  const { governanceByProvider } = await import("@/lib/governance");
  const govByProvider = await governanceByProvider();
  const isSuspended = (id: string) => govByProvider.get(id)?.suspended ?? false;

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
      fee: formatFee(m?.feeBips ?? null),
      votePower: formatWeiCompact(m?.wNatWeight ?? null),
      reward: formatWeiCompact(m?.delegatorReward ?? null),
      rewardEpoch: m?.lastEpoch ?? null,
      validators: m?.nodeIds.length ?? 0,
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
