// Generates the public provider list. The shape is a drop-in superset of the standard FTSO
// provider-list schema, so any wallet or app that reads that list can read this feed unchanged.
//
// Reference entry shape:
//   { chainId, name, description, url, address, logoURI, listed? }
// Top level: { name, timestamp, version: {major,minor,patch}, providers: [...] }

import { prisma } from "./db";
import { toChecksum } from "./validation";

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
  // Self-declared (provider-attested, not verified on-chain). Null when not declared.
  selfDeclared: {
    privateNode: boolean | null;
    algorithm: string | null; // "in-house" | "open-source" | null
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
  // Optional, additive. Absent if the entry has no on-chain match and isn't verified.
  flareregistry?: FeedProviderExtras;
}

export interface ProviderList {
  name: string;
  timestamp: string;
  version: { major: number; minor: number; patch: number };
  providers: FeedProvider[];
}

function resolveLogo(logoPath: string | null, sourceLogoURI: string | null): string {
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
  const addresses = await prisma.providerAddress.findMany({
    // Exclude archived (soft-deleted, departed) providers from the live feed; they are served
    // read-only at /api/feed/archived.json. archivedAt:null AND (verified OR imported).
    where: {
      provider: { is: { archivedAt: null } },
      OR: [{ verified: true }, { provider: { is: { source: "imported" } } }],
    },
    include: { provider: true },
    orderBy: [{ chainId: "asc" }, { provider: { name: "asc" } }],
  });

  // Qualification status per provider: the persisted LATCHED status (sticky; only revoked by a
  // long no-submit gap, advanced during ingestion), not a fresh per-render compute.
  const provForQual = await prisma.provider.findMany({
    where: {
      archivedAt: null,
      OR: [{ addresses: { some: { verified: true } } }, { source: "imported" }],
    },
    select: { id: true, addresses: { select: { address: true } } },
  });
  const { latchedRiskByAddresses } = await import("./qualification");
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
  const entityByAddress = new Map<string, (typeof entities)[number]>();
  for (const e of entities) {
    for (const addr of [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ]) {
      if (addr) entityByAddress.set(addr.toLowerCase(), e);
    }
  }

  const providers: FeedProvider[] = addresses.map((a) => {
    const entity = entityByAddress.get(a.address.toLowerCase());
    const latest = entity ? latestByVoter.get(`${entity.network}:${entity.voter}`) : undefined;
    const providerId = providerIdByAddress.get(a.address.toLowerCase()) ?? "";
    const risk = riskByProvider.get(providerId);
    const gov = govByProvider.get(providerId);
    // A suspended provider (DENIED governance outcome) is never Qualified/listed.
    const qualified = (risk?.qualified ?? false) && !gov?.suspended;
    const managementGroup = mgByProvider.get(providerId) ?? false;
    // Emit extras if there's anything to report: on-chain match, verified owner, or qualified.
    const extras: FeedProviderExtras | undefined =
      entity || a.verified || qualified
        ? {
            verified: a.verified,
            registered: !!entity,
            managementGroup,
            qualified,
            network: entity?.network ?? null,
            feePercent: entity?.feeBips != null ? entity.feeBips / 100 : null,
            votePower: entity?.wNatWeight ?? null,
            votePowerCapped: entity?.wNatCappedWeight ?? null,
            feedCount: entity?.feedCount ?? null,
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
            selfDeclared: {
              privateNode: a.provider.privateNode,
              algorithm: a.provider.algorithm,
            },
            qualification: {
              qualifiedSince: risk?.qualifiedSince ?? null,
              lastSubmittedEpoch: risk?.lastSubmittedEpoch ?? null,
              epochsSinceSubmit: risk?.epochsSinceSubmit ?? null,
              epochsUntilRevoke: risk?.epochsUntilRevoke ?? null,
              revokeAfterEpochs: risk?.revokeAfterEpochs ?? 17,
            },
            ...(govByProvider.get(providerId)
              ? { governance: govByProvider.get(providerId) }
              : {}),
          }
        : undefined;

    return {
      chainId: a.chainId,
      name: a.provider.name,
      description: a.provider.description,
      url: a.provider.url,
      address: toChecksum(a.address),
      logoURI: resolveLogo(a.provider.logoPath, a.provider.logoURI),
      // listed now reflects the automatic qualification status (was the imported source flag),
      // so wallets that filter on listed get the Qualified set.
      listed: qualified,
      ...(extras ? { flareregistry: extras } : {}),
    };
  });

  return {
    name: "Flare Registry FTSO Signal Providers",
    timestamp: new Date().toISOString(),
    version: { major: 1, minor: 3, patch: 0 },
    providers,
  };
}

// One archived (departed) provider, as served by the read-only archive endpoint.
export interface ArchivedProvider {
  name: string;
  description: string;
  url: string;
  source: string; // "submitted" | "imported"
  archivedAt: string | null;
  archivedReason: string | null;
  addresses: { chainId: number; address: string }[];
}

export interface ArchivedList {
  name: string;
  timestamp: string;
  note: string;
  providers: ArchivedProvider[];
}

// Build the archived-providers list for /api/feed/archived.json. This is the audit record of
// providers removed from the live feed (departed: unqualified and lapsed beyond the purge window).
// It is PURELY DERIVED from the database on each request - there is no stored archived file that
// anything writes to, so concurrent updates can never conflict (unlike the committed providerlist.json
// which a publish bot writes). One entry per archived provider, with all of its addresses.
export async function buildArchivedList(): Promise<ArchivedList> {
  const providers = await prisma.provider.findMany({
    where: { archivedAt: { not: null } },
    include: { addresses: { orderBy: { chainId: "asc" } } },
    orderBy: [{ archivedAt: "desc" }, { name: "asc" }],
  });
  return {
    name: "Flare Registry archived (departed) providers",
    timestamp: new Date().toISOString(),
    note: "Providers removed from the live feed after going inactive on-chain (unqualified and lapsed beyond the purge window). Kept for the public audit record; not part of the live provider list. A provider that becomes active again is automatically restored to the live feed.",
    providers: providers.map((p) => ({
      name: p.name,
      description: p.description,
      url: p.url,
      source: p.source,
      archivedAt: p.archivedAt ? p.archivedAt.toISOString() : null,
      archivedReason: p.archivedReason,
      addresses: p.addresses.map((a) => ({ chainId: a.chainId, address: a.address })),
    })),
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
    const list = await buildProviderList();
    const body = Buffer.from(JSON.stringify(list, null, 2) + "\n", "utf8");
    await commitFile(FEED_REPO_PATH, body, "feed: update providerlist.json");
  } catch (e) {
    // Do not fail the request; the dynamic /api/feed endpoint is still authoritative.
    console.error("publishFeedToRepo failed:", e instanceof Error ? e.message : e);
  }
}
