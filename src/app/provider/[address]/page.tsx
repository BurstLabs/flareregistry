import { notFound } from "next/navigation";
import type { LiveConductView, SubjectCase } from "@/lib/governance";
import { prisma } from "@/lib/db";
import { getChain } from "@/lib/chains";
import { metricsForProvider, formatWeiCompact, listingAddressesForSigner } from "@/lib/metrics";
import { qualifyProviders, latchedQualifiedByAddresses } from "@/lib/qualification";
import {
  isHeldNewProvider,
  isHeldNewClaim,
  inNewProviderWindow,
  holdAnchor,
  claimAnchor,
  NEW_PROVIDER_WINDOW_DAYS,
} from "@/lib/governance";
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

  // Management Group standing. The group is a single Flare mainnet contract, so only the Flare entity
  // has one; a Songbird-only provider gets no section rather than a misleading "not eligible".
  const flareEntity = entities.find((e) => e.network === "flare") ?? null;
  const mg =
    flareEntity && flareEntity.mgCheckedEpoch != null
      ? {
          identity: flareEntity.voter,
          member: flareEntity.managementGroup,
          memberSinceEpoch: flareEntity.mgMemberSinceEpoch,
          eligible: flareEntity.mgEligible,
          blockReason: flareEntity.mgBlockReason,
          rewardedStreak: flareEntity.mgRewardedStreak,
          requiredEpochs: flareEntity.mgRequiredEpochs,
          epochsRemaining: flareEntity.mgEpochsRemaining,
          blockedAtEpoch: flareEntity.mgBlockedAtEpoch,
          blockedUntil: flareEntity.mgBlockedUntil?.toISOString() ?? null,
          eligibleEstimatedAt: flareEntity.mgEligibleEstimatedAt?.toISOString() ?? null,
          blockedAtEpochTs: flareEntity.mgBlockedAtEpochTs?.toISOString() ?? null,
          checkedEpoch: flareEntity.mgCheckedEpoch,
          checkedAt: flareEntity.mgCheckedAt?.toISOString() ?? null,
          // Removal standing. Only meaningful for a sitting member; null everywhere else.
          removable: flareEntity.mgRemovable,
          removeReason: flareEntity.mgRemoveReason,
          missedVotes: flareEntity.mgMissedVotes,
          relevantProposals: flareEntity.mgRelevantProposals,
          missedVotesLimit: flareEntity.mgMissedVotesLimit,
          epochsSinceReward: flareEntity.mgEpochsSinceReward,
        }
      : null;

  // Reputation, per matched entity. Scoped to the entity the page's metrics describe, so it never
  // averages a healthy chain together with a struggling one. The eligibility record still exists and
  // still feeds the reliability component; it just no longer gets a section of its own, since the
  // component already states it.
  // FLARE ONLY, and keyed off the Flare entity rather than whichever network metricsForProvider
  // happened to pick. That helper prefers the most recently active network, so a provider active on
  // both would get whichever entity was one epoch fresher: Comfy Nodes scored 73.6 on Flare and 15 on
  // Songbird, and the page showed the Songbird figure under an unlabelled heading. A Songbird-only
  // provider now gets no section at all, which is honest, rather than a number that reads as Flare.
  const { reputationFor } = await import("@/lib/reputation");
  // FLARE WHERE THERE IS ONE, otherwise whatever chain this provider is actually on.
  //
  // This scored Flare and only Flare, so a Songbird-only provider got no reputation section at all
  // while its DIRECTORY CARD showed a score, because the card looks the score up by the provider's
  // own network. A reader following the card to the page found the number had vanished. Songbird
  // scores are real and current: 65 of them at the same method version as Flare's.
  //
  // The heading carries the network, which is what the Flare-only restriction was originally for:
  // the complaint it fixed was an UNLABELLED Songbird figure, not a Songbird figure.
  const scoredEntity = flareEntity ?? entities[0] ?? null;
  const reputation = scoredEntity
    ? await reputationFor(scoredEntity.network, scoredEntity.voter)
    : null;
  const reputationNetwork = scoredEntity?.network ?? null;

  const gov = (await (await import("@/lib/governance")).governanceByProvider()).get(p.id) ?? null;
  // Published conduct findings, entirely separate from the new-provider case record above. A
  // finding never affects `qualified`, `held` or the score; it is a statement of what the
  // Management Group decided, shown next to them.
  const conduct =
    (await (await import("@/lib/governance")).conductFindingsByProvider()).get(p.id) ?? [];

  // New-provider hold, decomposed into its two independent axes so the flag/badge logic stays clear:
  //  - heldWindow: the raw 30-day new-provider clock (createdAt-anchored), regardless of criteria.
  //  - liveCase:   a pending or under-review governance case (holds listing past the clock).
  // meetsCriteria is the on-chain qualification latch. A provider is effectively Qualified/listed
  // only when it meets criteria AND is not held by either axis (mirrors feed.ts and the directory).
  const nowDate = new Date();
  const meetsCriteria = latchedMap.get(p.id) ?? false;
  const anchor = holdAnchor(p);
  // TWO INDEPENDENT CLOCKS, and a provider lists only when both have run. The entity clock measures
  // time on-chain; the claim clock measures time since anyone asserted an identity for it. Neither
  // substitutes for the other, and for an ordinary submitted provider they start together.
  const claimedAt = claimAnchor(p);
  const heldWindow =
    isHeldNewProvider(anchor, nowDate) ||
    isHeldNewClaim(claimedAt, p.claimedFromSource, nowDate);
  const liveCase = !!gov?.underReview || !!gov?.pending;
  const held = meetsCriteria && (heldWindow || liveCase);
  // heldUntil (the "lists on {date}" note) reflects only the clock; a live case has no fixed end
  // date, so we only surface the auto-list date when the sole reason for the hold is the window.
  // NOT FOR A CHAIN-ONLY LISTING. `listed` is hardcoded false for source "onchain", so the clock
  // running out changes nothing and promising a date is simply untrue: this listing showed "Lists
  // automatically on September 2" for an entity that cannot list on any date until it is claimed.
  const heldUntil =
    held && heldWindow && !liveCase && p.source !== "onchain"
      ? new Date(
          Math.max(
            isHeldNewProvider(anchor, nowDate)
              ? anchor.getTime() + NEW_PROVIDER_WINDOW_DAYS * 86_400_000
              : 0,
            // The later of the two, since the provider is held until BOTH have elapsed. Showing the
            // earlier one would promise a listing date that comes and goes with nothing happening.
            claimedAt && isHeldNewClaim(claimedAt, p.claimedFromSource, nowDate)
              ? claimedAt.getTime() + NEW_PROVIDER_WINDOW_DAYS * 86_400_000
              : 0
          )
        ).toISOString()
      : null;

  // Same server-side resolution as the directory: the session is already on this request, so a
  // member's pending-case badge can be in the first paint instead of two round trips after it.
  // Depends on this route being force-dynamic, declared at the top of the file.
  const { getSessionAddress: getSess } = await import("@/lib/session");
  const {
    loadMembers: loadMg,
    memberVoterFor: mgVoterFor,
    CONDUCT_CO_INITIATORS_REQUIRED: MG_REQUIRED,
    liveConductForMember: liveConduct,
    subjectCasesFor: subjectCases,
  } = await import("@/lib/governance");
  let viewerIsMember = false;
  let viewerLiveCase: LiveConductView | null = null;
  /** The sealed cases against THIS listing, for a signed-in owner. Null for everyone else. */
  let viewerSubjectCases: SubjectCase[] | null = null;
  try {
    const sess = await getSess();
    if (sess) {
      const mg = await loadMg();
      if (mgVoterFor(sess, mg.voterByAddress)) {
        viewerIsMember = true;
        // THE WHOLE CASE, not just the count. A member opening the panel needs to read what they
        // would be co-signing, and fetching it after mount meant the details only appeared once the
        // panel was expanded and a round trip had completed.
        //
        // Built by the SAME function the API route uses. This page had its own copy of the query and
        // the mapping, and the two drifted the moment fields were added to one of them: endorsements
        // rendered as blank grounds here and the withdraw control never appeared, because this path
        // needs no fetch and is therefore the one every member actually hits.
        const memberVoter = mgVoterFor(sess, mg.voterByAddress)!;
        viewerLiveCase = await liveConduct(p.id, memberVoter);
      }

      // THE SUBJECT'S OWN NOTICES, resolved the same way and for the same reason.
      //
      // This panel sat behind a "Check for notices" button, so a provider who had been served with a
      // sealed case had to know to press something before the site would tell them. The session on
      // this request already proves who they are; asking them to prove it again with a wallet popup
      // added nothing except the chance they never found out.
      //
      // Independent of membership: the subject of a case is usually not a Management Group member,
      // and the two panels answer different questions.
      viewerSubjectCases = await subjectCases(p.id, sess.toLowerCase());
    }
  } catch {
    // Unreadable membership falls back to the client probe, which costs the old flicker, not the
    // feature.
  }
  const data: DetailData = {
    name: p.name,
    description: p.description,
    url: p.url,
    logo: cardLogo(p.logoPath, p.logoURI),
    verified: p.source === "submitted",
    onchainOnly: p.source === "onchain",
    registered: !!metrics?.registered,
    managementGroup: (await (await import("@/lib/management-group")).managementGroupByProvider()).get(p.id) ?? false,
    governance: gov,
    conduct,
    // A conduct case is the instrument for an ESTABLISHED provider, so it is offered exactly where
    // the new-provider flag is not: matched on-chain, not archived, and past the flag window. The
    // server enforces Management Group membership on the signature; this only decides whether the
    // form is worth showing at all.
    viewerIsMember,
    viewerLiveCase,
    viewerSubjectCases,
    conductEligible: entities.length > 0 && !p.archivedAt && !inNewProviderWindow(anchor, nowDate),
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
      inNewProviderWindow(anchor, nowDate),
    // Watchable: a new provider still in its review window. Anyone may subscribe to be emailed if it
    // is flagged; the subscription is shredded once it lists/qualifies (or is denied). Uses the raw
    // window (heldWindow) so it is offered throughout review regardless of criteria state.
    watchable: heldWindow && !p.suspended,
    // New-provider hold: qualifying providers still inside their 30-day window (or with a live case)
    // are not shown as Qualified/listed yet (same effect as listed:false), matching the feed and the
    // directory. Not MG-gated; auto-lists once the window elapses and no case is open.
    // NOT FOR AN UNCLAIMED CHAIN-ONLY LISTING. The three checks behind this are real and still
    // shown, but `listed` is hardcoded false for this tier, so badging it Qualified asserts an
    // eligibility it can never act on and contradicts the On-chain only badge beside it, whose own
    // tooltip says it stays out of the listed feed. Nine providers carried both badges at once.
    qualified: meetsCriteria && !held && p.source !== "onchain",
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
    singleEntity: !!p.singleEntity,
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
    mg,
    reputation,
    reputationNetwork,
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
