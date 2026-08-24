import type { ConductDirectoryView } from "@/lib/governance";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chains";
import { metricsForProviders, formatWeiCompact } from "@/lib/metrics";
import { qualifyProviders, latchedQualifiedByAddresses } from "@/lib/qualification";
import {
  isHeldNewProvider,
  isHeldNewClaim,
  holdAnchor,
  claimAnchor,
  NEW_PROVIDER_WINDOW_DAYS,
} from "@/lib/governance";
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
      OR: [{ addresses: { some: { verified: true } } }, { source: { in: ["imported", "onchain"] } }],
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
  // The hold anchor, not the row date; see holdAnchor in lib/governance.
  const createdById = new Map(all.map((p) => [p.id, holdAnchor(p)]));
  const sourceById = new Map(all.map((p) => [p.id, p.source]));
  // The claim clock, kept beside the entity clock; a provider is held until both have run.
  const claimedById = new Map(all.map((p) => [p.id, claimAnchor(p)]));
  // What the listing was before it was claimed; only a chain-only registration serves a window.
  const claimSrcById = new Map(all.map((p) => [p.id, p.claimedFromSource]));
  const held = (id: string) => {
    const c = createdById.get(id);
    const g = govByProvider.get(id);
    return (
      (c ? isHeldNewProvider(c, now) : false) ||
      isHeldNewClaim(claimedById.get(id) ?? null, claimSrcById.get(id) ?? null, now) ||
      !!g?.underReview ||
      !!g?.pending
    );
  };
  const isQualified = (id: string) => (latched.get(id) ?? false) && !held(id);
  // The auto-list date for a provider held SOLELY by the new-provider clock, mirroring the provider
  // detail page so the directory card explains the hold instead of silently showing a qualifying-but-
  // unlisted provider. Gated on meetsCriteria: the hold is only the reason a provider isn't listed
  // when it already passes every on-chain check. A provider still failing a check (e.g. uptime) is
  // unlisted because of that failure, not the clock, so surfacing "lists on {date}" would be
  // misleading (the date is irrelevant until the check passes). Null then, and null when a live case
  // has no fixed end date. Matches provider/[address]/page.tsx exactly.
  const heldUntil = (id: string) => {
    const c = createdById.get(id);
    const g = govByProvider.get(id);
    const liveCase = !!g?.underReview || !!g?.pending;
    const meetsCriteria = latched.get(id) ?? false;
    const cl = claimedById.get(id) ?? null;
    const byEntity = !!c && isHeldNewProvider(c, now);
    const byClaim = isHeldNewClaim(cl, claimSrcById.get(id) ?? null, now);
    // NOT FOR A CHAIN-ONLY LISTING, which has listed hardcoded false: the clock running out
    // changes nothing, so naming a date is a promise nothing will keep. Matches the detail page.
    if (sourceById.get(id) === "onchain") return null;
    if (!c || !meetsCriteria || liveCase || (!byEntity && !byClaim)) return null;
    // The later of the two clocks, matching provider/[address]/page.tsx exactly.
    return new Date(
      Math.max(
        byEntity ? c.getTime() + NEW_PROVIDER_WINDOW_DAYS * 86_400_000 : 0,
        byClaim && cl ? cl.getTime() + NEW_PROVIDER_WINDOW_DAYS * 86_400_000 : 0
      )
    ).toISOString();
  };
  // True if any qualification check passes. Zero passes = stale name, hidden even from "show all".
  const hasAnyPass = (id: string) =>
    (qualifications.get(id)?.checks ?? []).some((c) => c.status === "pass");

  const listable = all.filter((p) => hasAnyPass(p.id));
  // An "onchain" provider was seeded from the chain because it is registered and submitting, but
  // nothing publishes a name, a site or a logo for it and nobody has claimed it. It is held out of
  // the default view for that reason and not because of anything about its performance: it may well
  // be Qualified, and its card says so. Putting a row of bare addresses in front of every visitor
  // would be worse than the gap it closes, but hiding them entirely is what let a third-party list
  // decide, invisibly, which competitors this registry shows.
  const isOnchainOnly = (p: (typeof all)[number]) => p.source === "onchain";
  // Qualified count and the default view both exclude suspended providers. The "show all" view
  // still shows them (with a Suspended chip) so the record stays public.
  const qualifiedCount = listable.filter(
    (p) => isQualified(p.id) && !isSuspended(p.id) && !isOnchainOnly(p)
  ).length;
  const shown = showAll
    ? listable
    : listable.filter((p) => isQualified(p.id) && !isSuspended(p.id) && !isOnchainOnly(p));

  const metrics = await metricsForProviders(shown);

  // REPUTATION, read from the precomputed table rather than scored inline. Running the scorer here
  // would be ~14 queries per provider against every listing on the page. See compute-scores.
  //
  // The stored version is checked against the running one: the rules have moved several times, and a
  // row written under older rules is a different number wearing the same name. A mismatched row is
  // treated as absent, so a card shows no score rather than a misleading one.
  // PENDING CONDUCT CASES, resolved on the SERVER for a signed-in Management Group member.
  //
  // The client used to do this in two round trips after paint, confirm membership then fetch counts,
  // so a member watched the badges appear a beat after the cards. The session cookie is already on
  // this request and is proof of control, so both answers are available here and the badges can be
  // in the first byte of HTML.
  //
  // SAFE ONLY BECAUSE THIS ROUTE IS force-dynamic. Rendering per session means one member's view is
  // never handed to anyone else. If this page is ever made static or shared-cached, this block must
  // move back to the client, or a sealed case would be served to whoever got the cached copy.
  const { getSessionAddress } = await import("@/lib/session");
  const { loadMembers, memberVoterFor, conductDirectoryForMember } = await import("@/lib/governance");
  const session = await getSessionAddress();
  let viewerIsMember = false;
  let initialPending: ConductDirectoryView["pending"] = [];
  let initialOpen: ConductDirectoryView["open"] = [];
  if (session) {
    try {
      const members = await loadMembers();
      const memberVoter = memberVoterFor(session, members.voterByAddress);
      if (memberVoter) {
        viewerIsMember = true;
        // The SAME loader the API uses, so the badges a member sees in the first paint and the ones
        // they see after a refetch cannot disagree. This shape had been written out twice before.
        const dir = await conductDirectoryForMember(memberVoter);
        initialPending = dir.pending;
        initialOpen = dir.open;
      }
    } catch {
      // Membership unreadable: fall through as a non-member. The client still probes after mount, so
      // a transient failure here costs the flicker it used to have, not the feature.
    }
  }

  const { REPUTATION_VERSION } = await import("@/lib/reputation");
  const scoreRows = await prisma.providerScore.findMany({
    where: { version: REPUTATION_VERSION },
    select: { network: true, voter: true, score: true, band: true },
  });
  const scoreByVoter = new Map(
    scoreRows.map((r) => [`${r.network}:${r.voter.toLowerCase()}`, r])
  );
  // A provider is matched through its entity, which is what the score is keyed by. metricsForProviders
  // already resolved that entity, so reuse it rather than repeating the five-role join.
  // FLARE ONLY, matching the provider page. This looked the score up on the provider's OWN
  // network, so a Songbird-only provider carried "17 - Needs attention" on its card while the page
  // it linked to showed no score at all, because that page has always scored Flare and nothing
  // else. A number visible exactly where it cannot be examined is the worst of the two.
  const scoreFor = (id: string) => {
    const m = metrics.get(id);
    if (!m || m.network !== "flare") return null;
    return scoreByVoter.get(`flare:${m.voter.toLowerCase()}`) ?? null;
  };
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
      // See the provider page: a chain-only listing shows its checks but never claims to qualify,
      // since it cannot be listed. The qualified COUNT above already excluded these.
      qualified: isQualified(p.id) && !isOnchainOnly(p),
      heldUntil: heldUntil(p.id),
      registered: !!m?.registered,
      managementGroup: mgByProvider.get(p.id) ?? false,
      verified: p.source === "submitted",
      onchainOnly: isOnchainOnly(p),
      roles: m?.roles ?? [],
      reputation: (() => {
        const r = scoreFor(p.id);
        return r ? { score: r.score, band: r.band } : null;
      })(),
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
      singleEntity: !!p.singleEntity,
      algorithm: p.algorithm,
      detailAddress: p.addresses[0]?.address ?? "",
    };
  });

  return (
    <DirectoryClient
      providers={cards}
      total={listable.length}
      qualifiedCount={qualifiedCount}
      viewerIsMember={viewerIsMember}
      initialPending={initialPending}
      initialOpen={initialOpen}
      showAll={showAll}
    />
  );
}
