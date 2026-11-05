// Generates the public provider list. The shape is a drop-in superset of the standard FTSO
// provider-list schema, so any wallet or app that reads that list can read this feed unchanged.
//
// Reference entry shape:
//   { chainId, name, description, url, address, logoURI, listed? }
// Top level: { name, timestamp, version: {major,minor,patch}, providers: [...] }

import { prisma } from "./db";
import { toChecksum } from "./validation";
import { isHeldNewProvider, isHeldNewClaim, holdAnchor } from "./governance";
import { getChain } from "./chains";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? "http://localhost:3000";

// Enriched, Flare Registry-specific metrics, added under a namespaced key so the 7 base fields
// stay byte-compatible with the standard provider-list schema (consumers ignore unknown keys).
export interface FeedProviderExtras {
  verified: boolean; // owner proved control of this address by signature
  registered: boolean; // matched to a registered FTSO entity in Flare's on-chain reward data
  managementGroup: boolean; // member of Flare's on-chain FTSO Management Group (curated, earned)
  qualified: boolean; // meets all automatable qualification criteria (see /api docs)
  network: string | null; // "flare" | "songbird" - the network the metrics are from
  feePercent: number | null; // delegation fee, percent
  votePower: string | null; // wNat weight, wei-scale decimal string
  votePowerCapped: string | null;
  feedCount: number | null;
  lastEpoch: number | null;
  // Month this provider first appeared on this network, as "YYYY-MM", or null if not yet resolved.
  // Derived from the earliest transaction its delegation address sent, which reaches back to each
  // network's FTSO launch (Songbird 2021-09, Flare 2022-07); see scripts/backfill-first-activity.mjs
  // for why reward data cannot answer this. A month, not a day: the underlying signal is a proxy for
  // when an operator started and does not justify finer precision.
  activeSince: string | null;
  delegatorRewardLastEpoch: string | null; // wei-scale decimal string
  feeRewardLastEpoch: string | null;
  // The entity's five registered on-chain addresses (null if not matched on-chain). These are
  // the distinct roles a Flare FTSO entity registers via the EntityManager.
  entity: {
    identity: string | null; // the voter / identity address
    submit: string | null;
    submitSignatures: string | null;
    signingPolicy: string | null;
    delegation: string | null;
  } | null;
  // Validator (P-chain node) stats for the entity's registered node ids, joined by nodeId. Same data
  // shown on the directory: fee/uptime/connected/weight/delegatorCount. Empty array if none.
  validators: {
    nodeId: string;
    feePercent: number | null;
    uptimePercent: number | null;
    connected: boolean;
    weight: string | null; // TOTAL stake (self-bond + delegated), decimal string
    selfBond: string | null; // the validator's own bond
    delegatedWeight: string | null; // stake delegated to the node by others
    delegatorCount: number | null;
  }[];
  // Self-declared (provider-attested, not verified on-chain). Null when not declared.
  selfDeclared: {
    privateNode: boolean | null;
    algorithm: string | null; // "in-house" | "open-source" | null
    singleEntity: boolean | null; // operator attests one registered entity per network
  };
  // Qualification liveness/risk: how close a qualified provider is to losing Qualified. A
  // qualified provider is revoked after `revokeAfterEpochs` consecutive epochs of not submitting.
  qualification: {
    qualifiedSince: string | null; // ISO timestamp the current Qualified latch began
    lastSubmittedEpoch: number | null;
    epochsSinceSubmit: number | null; // 0 = submitted in the latest epoch
    epochsUntilRevoke: number | null; // missed epochs remaining before revocation
    revokeAfterEpochs: number; // the threshold
  };
  // WHY this entry is or is not listed, which `listed` alone cannot say: it is false for a
  // provider inside its 30-day hold, one that stopped submitting last week, one that stopped three
  // years ago, one suspended by a governance vote, and one the chain shows but nobody has named.
  // Those are different facts and a consumer should not have to infer them from epoch arithmetic.
  //
  // `listed === (status === "listed")` holds by construction; the two are computed together.
  //
  //   listed       meets every criterion and is past its hold
  //   held         qualified, but inside the 30-day new-provider or new-claim window
  //   unqualified  does not currently meet the criteria
  //   departed     not qualified and silent for PURGE_AFTER_EPOCHS reward epochs or more
  //   suspended    a governance case closed against it
  //   unnamed      registered on-chain, but no list or owner has ever published an identity
  //
  // This replaced a separate archive endpoint. A departed provider used to be removed from the
  // feed entirely, which told consumers nothing and left them to find a name elsewhere.
  status: "listed" | "held" | "unqualified" | "departed" | "suspended" | "unnamed";
  // FRESHNESS, for a consumer holding a second provider list that disagrees with this one.
  //
  // updatedAt: when this entry's published content (name, description, url, logoURI) last changed.
  // Null on an entry we did not author, i.e. one still carrying an upstream list's text, because
  // the date we copied a row says nothing about when its provider last stood behind it.
  //
  // attestedAt: when this address last proved control by signing a challenge with an on-chain role
  // key. Null if the entry has never been claimed. This is the date that settles a disagreement:
  // it says the subject of the record, not a third party, put the text there.
  //
  // See lib/content-stamp for why neither can be a row timestamp.
  updatedAt: string | null;
  attestedAt: string | null;
  // Governance (Management Group flag mechanism). Present so third parties can show the same
  // public status. underReview = an open flag case; suspended = a DENIED outcome.
  governance?: {
    underReview: boolean;
    suspended: boolean;
    caseId: string | null;
    state: string | null;
  };
}

export interface FeedProvider {
  chainId: number;
  name: string;
  description: string;
  url: string;
  address: string; // checksummed, to match the standard provider list
  logoURI: string;
  listed: boolean;
  // Present on every entry. It used to be omitted where there was no on-chain match and no
  // verified owner, which left exactly the entries that most need explaining, the second-network
  // address of a departed provider, with no way to say why they are unlisted.
  flareregistry: FeedProviderExtras;
}

export interface ProviderList {
  name: string;
  timestamp: string;
  version: { major: number; minor: number; patch: number };
  providers: FeedProvider[];
}

export function resolveLogo(logoPath: string | null, sourceLogoURI: string | null): string {
  // Prefer a self-hosted logo, then the imported source URL, then a placeholder.
  if (logoPath)
    return `${PUBLIC_BASE_URL}${logoPath.startsWith("/") ? "" : "/"}${logoPath}`;
  if (sourceLogoURI) return sourceLogoURI;
  return `${PUBLIC_BASE_URL}/logo-placeholder.png`;
}

/**
 * Build the feed. An entry appears if it's owner-verified OR imported as a launch seed. Each
 * carries its own `listed` flag: verified entries are listed, imports keep the source's value.
 */
export async function buildProviderList(): Promise<ProviderList> {
  const now = new Date();
  const addresses = await prisma.providerAddress.findMany({
    // A departed provider is NOT removed from the feed. It stays, with listed:false, which is the
    // flag whose whole job is "should a picker show this". Carrying two mechanisms for one
    // conclusion meant the second one drifted: fifty-three entries were published saying "not
    // registered on-chain" when we held an on-chain row and a last-seen epoch for seventeen of
    // them. It also left consumers with nothing at those addresses, so Flare's Systems Explorer
    // took the names for twenty-nine still-registered entities from a provider list that was
    // archived on 2026-11-05 and can never be updated again.
    //
    // What is still excluded is anything with no on-chain presence AND no claim; see below.
    where: {
      OR: [
        { verified: true },
        { provider: { is: { source: { in: ["imported", "onchain"] } } } },
        // AN ADDRESS AN UPSTREAM LIST ALREADY VOUCHED FOR, which `listed` carries verbatim from
        // the import and which no unproven submission can set: the submit route writes
        // listed:isControlled on create and only raises it for an address the session controls.
        //
        // Without this, CLAIMING A LISTING DELETED THE OTHER NETWORK'S ENTRY. An imported listing
        // published both of its networks, because the provider's source was "imported". The owner
        // then signed with one network's key, source flipped to "submitted", and every unverified
        // address on the listing silently left the feed. AU, HEWG and uGaenn each lost their
        // Songbird entry at the exact minute they proved who they were on Flare: all three are
        // listed and active on Songbird at the current epoch, and Flare's Systems Explorer has
        // been taking their names from an archived repository ever since.
        //
        // Proving one network cannot un-vouch another. The upstream listing stands until an owner
        // replaces it or the entity leaves the chain.
        { listed: true },
      ],
    },
    include: { provider: { include: { chainDescriptions: true } } },
    orderBy: [{ chainId: "asc" }, { provider: { name: "asc" } }],
  });

  // EARLIEST CLAIM per provider, for the claim hold. Built from the rows already loaded rather
  // than re-queried: a verified ProviderAddress IS a claim, and its verifiedAt is when it happened.
  const claimedByProvider = new Map<string, Date>();
  for (const a of addresses) {
    if (!a.verified || !a.verifiedAt) continue;
    const cur = claimedByProvider.get(a.providerId);
    if (!cur || a.verifiedAt < cur) claimedByProvider.set(a.providerId, a.verifiedAt);
  }

  // Qualification status per provider: the persisted LATCHED status (sticky; only revoked by a
  // long no-submit gap, advanced during ingestion), not a fresh per-render compute.
  const provForQual = await prisma.provider.findMany({
    where: {
      OR: [{ addresses: { some: { verified: true } } }, { source: { in: ["imported", "onchain"] } }],
    },
    select: { id: true, addresses: { select: { address: true } } },
  });
  const { latchedRiskByAddresses, PURGE_AFTER_EPOCHS } = await import("./qualification");
  const riskByProvider = await latchedRiskByAddresses(
    provForQual.map((p) => ({ id: p.id, addresses: p.addresses.map((a) => a.address) }))
  );
  // Map providerId by address so a per-address feed row can find its provider's qualification.
  const providerIdByAddress = new Map<string, string>();
  for (const pr of provForQual)
    for (const a of pr.addresses) providerIdByAddress.set(a.address.toLowerCase(), pr.id);

  // Management Group membership per provider (on-chain curated set).
  const { managementGroupByProvider } = await import("./management-group");
  const mgByProvider = await managementGroupByProvider();

  // Governance status per provider (open flag case / suspension).
  const { governanceByProvider } = await import("./governance");
  const govByProvider = await governanceByProvider();

  // Index on-chain entities by every address they own, so a feed entry's address can be
  // matched to its entity + latest-epoch metrics. One pass, no per-row query.
  const entities = await prisma.providerOnchain.findMany();
  const latestByVoter = new Map<string, { epochId: number; feeReward: string | null; delegatorReward: string | null }>();
  if (entities.length) {
    const latest = await prisma.providerMetricEpoch.findMany({
      where: { voter: { in: entities.map((e) => e.voter) } },
      orderBy: { epochId: "desc" },
    });
    for (const m of latest) {
      const key = `${m.network}:${m.voter}`;
      if (!latestByVoter.has(key))
        latestByVoter.set(key, { epochId: m.epochId, feeReward: m.feeReward, delegatorReward: m.delegatorReward });
    }
  }
  // Key by `${network}:${address}`, NOT address alone: a provider can register the SAME role address
  // (commonly the delegation address) on both Flare and Songbird. An address-only map lets whichever
  // entity is processed last clobber the key, so both networks' feed entries would resolve to the same
  // (wrong-network) entity - e.g. a Flare (chainId 14) entry reporting Songbird metrics. Scoping by
  // network keeps each chain's entry matched to its own on-chain entity.
  const entityByNetworkAddress = new Map<string, (typeof entities)[number]>();
  for (const e of entities) {
    for (const addr of [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ]) {
      if (addr) entityByNetworkAddress.set(`${e.network}:${addr.toLowerCase()}`, e);
    }
  }

  // Validator (P-chain node) stats for every provider, loaded once and keyed by "network:nodeId" so
  // each entry can join its entity's node ids without an N+1 query.
  const { allValidatorsByNetworkNode, toNodeId } = await import("./validators");
  const validatorByNetworkNode = await allValidatorsByNetworkNode();

  // WHAT WE PUBLISH, now that nothing is archived out of the feed.
  //
  // A provider is published when we hold evidence of our own for it: an address its owner signed
  // for, or a match to an entity registered on-chain. A departed provider still has both, so it
  // stays in the list at listed:false and a consumer can still resolve its name. That is the whole
  // point of the change: twenty-nine still-registered entities were taking their name and logo
  // from a provider list archived on 2026-11-05, because we published nothing at those addresses.
  //
  // Excluded: rows with neither. Thirty-six of those exist, seeded from that legacy list in June
  // for operators we have never found on-chain on either network. That is another project's record
  // of its own past, not ours, and republishing it would put names in front of consumers for
  // entities with no chain presence at all.
  // Per ENTRY, not per provider. A provider gone from Flare but never registered on Songbird has a
  // Songbird row only because a legacy list put one there; publishing it would assert a presence
  // on a network where there is none, and it reads as "unqualified" when the truth is "not here".
  //
  // The qualified clause is what keeps the one legitimate case: an operator whose entity we match
  // on one network and whose listing on the other is carried by the provider-level qualification
  // latch. Dropping it would unlist a currently-listed entry.
  const isPublishable = (a: (typeof addresses)[number]) => {
    const net = getChain(a.chainId)?.key;
    if (net && entityByNetworkAddress.has(`${net}:${a.address.toLowerCase()}`)) return true;
    if (a.verified) return true;
    return riskByProvider.get(providerIdByAddress.get(a.address.toLowerCase()) ?? "")?.qualified ?? false;
  };

  // Latest epoch seen per network, which is what "silent since" is measured against below.
  const latestEpochByNetwork = new Map<string, number>();
  for (const e of entities) {
    if (e.lastEpochSeen > (latestEpochByNetwork.get(e.network) ?? -1)) {
      latestEpochByNetwork.set(e.network, e.lastEpochSeen);
    }
  }

  const publishable = addresses.filter(isPublishable);

  const providers: FeedProvider[] = publishable.map((a) => {
    // Match the entity on THIS entry's network (derived from its chainId), not address alone, so a
    // role address shared across Flare and Songbird resolves to the right-network entity.
    const entryNetwork = getChain(a.chainId)?.key ?? null;
    const entity = entryNetwork
      ? entityByNetworkAddress.get(`${entryNetwork}:${a.address.toLowerCase()}`)
      : undefined;
    const latest = entity ? latestByVoter.get(`${entity.network}:${entity.voter}`) : undefined;
    const providerId = providerIdByAddress.get(a.address.toLowerCase()) ?? "";
    const risk = riskByProvider.get(providerId);
    const gov = govByProvider.get(providerId);
    // A suspended provider (DENIED governance outcome) is never Qualified/listed.
    const qualified = (risk?.qualified ?? false) && !gov?.suspended;
    // New-provider hold: even a qualifying provider is not LISTED until its 30-day new-provider
    // window has elapsed, so a pre-warmed on-chain entity
    // cannot register and instantly appear in wallets before the Management Group can react. The
    // Qualified badge still reflects `qualified`; only feed listing waits out the window.
    //
    // A live governance case ALSO holds listing, independent of the clock: a flag case can be
    // opened as late as day 29 of the window and runs ~14 more days, outliving the hold. Without
    // this, the provider would auto-list at day 30 while its suspension vote is still open, then get
    // yanked back only at the verdict. Keep it unlisted while any case is pending or under review so
    // it never reaches wallets mid-vote; a CLEARED/expired case lets it list normally afterwards.
    const held =
      isHeldNewProvider(holdAnchor(a.provider), now) ||
      // The claim clock, which the entity clock cannot stand in for: see isHeldNewClaim.
      isHeldNewClaim(
        claimedByProvider.get(providerId) ?? null,
        a.provider.claimedFromSource,
        now
      ) ||
      (gov?.underReview ?? false) ||
      (gov?.pending ?? false);
    const managementGroup = mgByProvider.get(providerId) ?? false;

    // DEPARTED: not qualified and silent for PURGE_AFTER_EPOCHS reward epochs, measured against
    // the latest epoch seen on this entry's own network. The same threshold the registry used to
    // archive a provider on, except the entry now stays and says so.
    const latestEpoch = entity ? latestEpochByNetwork.get(entity.network) : undefined;
    const silence = entity && latestEpoch !== undefined ? latestEpoch - entity.lastEpochSeen : null;
    const departed = !qualified && silence !== null && silence >= PURGE_AFTER_EPOCHS;
    // Ordered most specific first. departed outranks unnamed because "gone" says more about a
    // chain-seeded row than "nobody named it", and both outrank the bare "unqualified".
    const status: FeedProviderExtras["status"] = gov?.suspended
      ? "suspended"
      : departed
        ? "departed"
        : a.provider.source === "onchain"
          ? "unnamed"
          : !qualified
            ? "unqualified"
            : held
              ? "held"
              : "listed";

    // Emitted for every published entry. An entry we publish should always be able to say why it
    // is or is not listed; on-chain fields are simply null where this network has no entity.
    const extras: FeedProviderExtras = {
      verified: a.verified,
      registered: !!entity,
      managementGroup,
      qualified,
      network: entity?.network ?? null,
      feePercent: entity?.feeBips != null ? entity.feeBips / 100 : null,
      votePower: entity?.wNatWeight ?? null,
      // delegationWeightCapped, NOT wNatCappedWeight. Verified decisively against the chain:
      // isqrt(S)*isqrt(isqrt(S)) with S = delegationWeightCapped + 5*stakingWeight reproduces
      // VoterRegistry.getVoterRegistrationWeight for 97/97 Flare voters; the same computation with
      // wNatCappedWeight reproduces 2/97. wNatCappedWeight comes from the lagging fsp-rewards
      // ingest and is a different, staler quantity that merely looks plausible (26,542M FLR against
      // the correct 24,443M). Publishing it here understated the cap for every consumer of this
      // feed, and at least one third-party analysis was built on the wrong figure as a result.
      votePowerCapped: entity?.delegationWeightCapped ?? entity?.wNatCappedWeight ?? null,
      feedCount: entity?.feedCount ?? null,
      activeSince: entity?.firstActivityAt
        ? entity.firstActivityAt.toISOString().slice(0, 7)
        : null,
      lastEpoch: latest?.epochId ?? null,
      delegatorRewardLastEpoch: latest?.delegatorReward ?? null,
      feeRewardLastEpoch: latest?.feeReward ?? null,
      entity: entity
        ? {
            identity: toChecksum(entity.voter),
            submit: entity.submitAddress ? toChecksum(entity.submitAddress) : null,
            submitSignatures: entity.submitSignaturesAddress
              ? toChecksum(entity.submitSignaturesAddress)
              : null,
            signingPolicy: entity.signingPolicyAddress
              ? toChecksum(entity.signingPolicyAddress)
              : null,
            delegation: entity.delegationAddress
              ? toChecksum(entity.delegationAddress)
              : null,
          }
        : null,
      validators:
        entity && Array.isArray(entity.nodeIds)
          ? (entity.nodeIds as string[]).map((raw) => {
              const nodeId = toNodeId(raw);
              const v = validatorByNetworkNode.get(`${entity.network}:${nodeId}`);
              return {
                nodeId,
                feePercent: v?.feePercent ?? null,
                uptimePercent: v?.uptimePercent ?? null,
                connected: v?.connected ?? false,
                weight: v?.weight ?? null,
                selfBond: v?.selfBond ?? null,
                delegatedWeight: v?.delegatedWeight ?? null,
                delegatorCount: v?.delegatorCount ?? null,
              };
            })
          : [],
      selfDeclared: {
        privateNode: a.provider.privateNode,
        algorithm: a.provider.algorithm,
        singleEntity: a.provider.singleEntity,
      },
      qualification: {
        qualifiedSince: risk?.qualifiedSince ?? null,
        lastSubmittedEpoch: risk?.lastSubmittedEpoch ?? null,
        epochsSinceSubmit: risk?.epochsSinceSubmit ?? null,
        epochsUntilRevoke: risk?.epochsUntilRevoke ?? null,
        revokeAfterEpochs: risk?.revokeAfterEpochs ?? 17,
      },
      status,
      // Only for listings whose text is ours to date. "imported" and "onchain" rows publish
      // somebody else's content or no content at all; see FeedProviderExtras above.
      updatedAt:
        a.provider.source === "submitted" && a.contentUpdatedAt
          ? a.contentUpdatedAt.toISOString()
          : null,
      attestedAt: a.attestedAt ? a.attestedAt.toISOString() : null,
      ...(govByProvider.get(providerId)
        ? { governance: govByProvider.get(providerId) }
        : {}),
    };

    return {
      chainId: a.chainId,
      name: a.provider.name,
      // Per-network text when the provider has set one for THIS chain, otherwise the single
      // provider-level description. Most providers have no override and take the fallback; see
      // ProviderChainDescription for why the override exists at all.
      description:
        a.provider.chainDescriptions.find((d) => d.chainId === a.chainId)?.description ??
        a.provider.description,
      url: a.provider.url,
      address: toChecksum(a.address),
      logoURI: resolveLogo(a.provider.logoPath, a.provider.logoURI),
      // listed reflects automatic qualification, minus any provider still inside its 30-day
      // new-provider hold, so wallets that filter on listed get the Qualified-and-settled set.
      //
      // An "onchain" entry is NEVER listed, however qualified it is. It was seeded from the chain
      // because it is registered and submitting, but nothing anywhere publishes a name, a site or a
      // logo for it, and it has never been claimed. The feed carries it so the record of who is
      // actually on the chain is complete; a wallet filtering on listed=true keeps exactly the set it
      // had before this tier existed, which is the point. It starts listing the moment its owner
      // claims it and the source flips to "submitted".
      listed: a.provider.source === "onchain" ? false : qualified && !held,
      flareregistry: extras,
    };
  });

  return {
    name: "Flare Registry FTSO Signal Providers",
    timestamp: new Date().toISOString(),
    version: { major: 1, minor: 3, patch: 0 },
    providers,
  };
}

// Path of the committed feed in the public assets repo, so wallets can fetch a static file
// (raw.githubusercontent.com/<assets-repo>/main/providerlist.json) the way they fetch the
// the standard provider list, in addition to the dynamic /api/feed endpoint.
export const FEED_REPO_PATH = "providerlist.json";

/**
 * Regenerate the provider list and commit it to the public assets repo. Called after any
 * change to provider data so the committed file tracks the live feed. Best-effort: failures
 * are logged and swallowed so they never break the user action that triggered them.
 */
export async function publishFeedToRepo(): Promise<void> {
  try {
    const { commitFile } = await import("./github");
    // BEFORE the build, so a change that triggered this publish is dated in the file it produces.
    // Every write path that can touch branding ends here, which is why the stamp lives here rather
    // than in each of them.
    const { stampEntryContent } = await import("./content-stamp");
    await stampEntryContent(resolveLogo).catch((e) => {
      // A failed stamp must not stop the feed going out: a slightly stale date is recoverable, a
      // feed that stopped republishing is not.
      console.error("stampEntryContent failed:", e instanceof Error ? e.message : e);
      return 0;
    });
    const list = await buildProviderList();
    const body = Buffer.from(JSON.stringify(list, null, 2) + "\n", "utf8");
    await commitFile(FEED_REPO_PATH, body, "feed: update providerlist.json");
  } catch (e) {
    // Do not fail the request; the dynamic /api/feed endpoint is still authoritative.
    console.error("publishFeedToRepo failed:", e instanceof Error ? e.message : e);
  }
}
