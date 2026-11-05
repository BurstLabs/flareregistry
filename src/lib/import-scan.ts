// Scan Bifrost Wallet's provider catalog for entries NOT yet in our registry, and stage them as
// ImportCandidates for admin review. Approving a candidate creates an unclaimed source="imported" Provider that then
// follows the normal path (it lists only once it qualifies on-chain or the owner claims it).
//
// Design notes:
// - Dedupe key is (chainId, lowercased address), matched against our ProviderAddress rows AND existing
//   candidates, so an entry we already have (by any means) is never surfaced.
// - Only NEW-to-us entries are staged (scope decision: additions only, not upstream edits).
// - A dismissed candidate is kept as a tombstone so it is not re-surfaced on the next scan.
// - Candidates whose address later appears in our registry are auto-marked "absorbed".
import { prisma } from "./db";
import { CHAINS, isSupportedChain, getChainByKey } from "./chains";
import { isClean } from "./content-filter";

// Bifrost Wallet's catalog, one aggregate per network (there is no global all.json).
//
// This replaced TowoLabs/ftso-signal-providers, which Bifrost ARCHIVED on 2026-11-05 after merging
// fourteen of its nineteen open pull requests. The old raw URL still answers 200 and always will,
// frozen at the 5 November file, which is exactly why this had to move: a dead source that keeps
// returning a healthy 200 never fails, it just stops being true, and nothing here would have
// noticed. The scan would have gone on reporting "no new additions" forever.
export const BIFROST_LIST_URL = (chainId: number) =>
  process.env.BIFROST_LIST_URL_TEMPLATE?.replace("{chainId}", String(chainId)) ??
  `https://raw.githubusercontent.com/bifrostwallet/assets/main/data/providers/eip155-${chainId}/all.json`;

/** One entry of a Bifrost per-network aggregate, reduced to the fields we import. */
interface UpstreamEntry {
  name?: string;
  description?: string;
  websiteURL?: string;
  logoURL?: string;
  identityAddress?: string;
  delegationAddress?: string;
}

export interface ScanResult {
  fetched: number; // entries in the upstream list
  newToUs: number; // entries not in our registry
  staged: number; // pending candidates created this run
  refreshed: number; // existing pending candidates whose snapshot was updated
  absorbed: number; // pending/dismissed candidates whose address now exists in our DB
  // Chain sweep (see scanOnchainEntities): entities registered on-chain that no upstream list
  // carries, staged from the chain itself.
  chainScanned?: number;
  chainNewToUs?: number;
  chainStaged?: number;
  chainSkippedStale?: number;
  error?: string;
}

/**
 * Every role address of every on-chain entity we already cover, plus a resolver from any single
 * address to its entity's full role set.
 *
 * A provider registers ONE of five role addresses (identity/voter, submit, submitSignatures,
 * signingPolicy, delegation) and different sources pick different ones, so an exact address match is
 * never sufficient to decide "do we have this".
 */
async function coverageIndex() {
  const ours = await prisma.providerAddress.findMany({ select: { address: true } });
  const ourAddrs = new Set(ours.map((a) => a.address.toLowerCase()));

  const entities = await prisma.providerOnchain.findMany();
  const rolesOf = (e: (typeof entities)[number]) =>
    [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ]
      .filter((r): r is string => !!r)
      .map((r) => r.toLowerCase());

  // If we list an entity by ANY of its role addresses, every role address counts as ours.
  for (const e of entities) {
    const roles = rolesOf(e);
    if (roles.some((r) => ourAddrs.has(r))) for (const r of roles) ourAddrs.add(r);
  }
  return { ourAddrs, entities, rolesOf };
}

// Clamp overly long upstream strings to our column limits so a candidate can always be approved.
function clamp(s: unknown, max: number): string {
  return typeof s === "string" ? s.slice(0, max) : "";
}

/**
 * Fetch the upstream list and reconcile it into the ImportCandidate queue. Idempotent: safe to run on
 * a schedule and by hand. Never throws on a bad upstream response - returns { error } instead so a
 * cron logs it rather than crashing.
 */
export async function scanBifrostImports(): Promise<ScanResult> {
  const result: ScanResult = { fetched: 0, newToUs: 0, staged: 0, refreshed: 0, absorbed: 0 };

  // One file per network. A network that fails to read ABORTS the run rather than contributing
  // nothing: an empty half is indistinguishable from "that network has no new providers", and the
  // scan would report a clean result while having looked at half the catalog.
  const providers: { chainId: number; entry: UpstreamEntry }[] = [];
  for (const chain of CHAINS) {
    try {
      const res = await fetch(BIFROST_LIST_URL(chain.chainId), { cache: "no-store" });
      if (!res.ok) return { ...result, error: `upstream ${chain.key}: HTTP ${res.status}` };
      const list = await res.json();
      if (!Array.isArray(list)) return { ...result, error: `upstream ${chain.key}: not an array` };
      for (const entry of list) providers.push({ chainId: chain.chainId, entry });
    } catch (e) {
      return { ...result, error: `fetch ${chain.key} failed: ${(e as Error).message}` };
    }
  }
  result.fetched = providers.length;

  // Match is by address alone (not chain-scoped): the five role addresses identify one operator, and
  // an upstream entry we'd import on network X is the same operator we already cover on network Y.
  const { ourAddrs } = await coverageIndex();

  // Existing candidates, keyed the same way, so we update snapshots / auto-absorb rather than dupe.
  const existing = await prisma.importCandidate.findMany();
  const candByKey = new Map(existing.map((c) => [`${c.chainId}:${c.address.toLowerCase()}`, c]));

  const now = new Date();
  const seenThisRun = new Set<string>();

  for (const { chainId, entry } of providers) {
    if (!entry || !isSupportedChain(chainId)) continue;
    // The DELEGATION address, which is what the old list published and what our own listing rows
    // are keyed on, so a candidate staged before the source moved keeps its identity instead of
    // being staged a second time under a different role address. Falls back to the identity
    // address, which the new catalog keys its directories on and always carries.
    const addr = (entry.delegationAddress || entry.identityAddress || "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
    const key = `${chainId}:${addr}`;
    seenThisRun.add(key);

    // Skip content that fails our filter (defensive - upstream is trusted, but names feed our UI).
    const name = clamp(entry.name, 80);
    if (!name || !isClean(name)) continue;

    const snapshot = {
      name,
      description: clamp(entry.description, 600),
      url: clamp(entry.websiteURL, 200),
      logoURI: typeof entry.logoURL === "string" ? entry.logoURL.slice(0, 300) : null,
    };

    if (ourAddrs.has(addr)) {
      // We already have this provider (by this address OR another role address of the same entity).
      // If a stale candidate exists for it, mark it absorbed.
      const c = candByKey.get(key);
      if (c && (c.status === "pending" || c.status === "dismissed")) {
        await prisma.importCandidate.update({
          where: { id: c.id },
          data: { status: "absorbed", lastSeenAt: now },
        });
        result.absorbed++;
      }
      continue;
    }

    result.newToUs++;
    const c = candByKey.get(key);
    if (!c) {
      await prisma.importCandidate.create({
        data: { source: "bifrost", chainId, address: addr, ...snapshot },
      });
      result.staged++;
    } else if (c.status === "pending") {
      // Keep the pending snapshot fresh (upstream may have edited name/logo since first sight).
      await prisma.importCandidate.update({
        where: { id: c.id },
        data: { ...snapshot, lastSeenAt: now },
      });
      result.refreshed++;
    }
    // status approved/dismissed/absorbed: leave as-is (already actioned).
  }

  return result;
}

/**
 * SWEEP THE CHAIN, not a list.
 *
 * scanBifrostImports above can only ever surface providers that some other project already chose to
 * write down. That made the registry's real boundary "whoever Bifrost lists", which is a
 * narrower and less defensible set than "whoever is registered on Flare": at the time this was
 * written, thirteen currently-registered, actively-submitting, Qualified entities were invisible
 * here purely because no upstream list carried them. This site is run by an operator who also
 * competes as a signal provider, so a membership boundary drawn by an undisclosed third-party list
 * is exactly the kind of thing that should not be deciding which competitors appear.
 *
 * So the chain is the seed and the upstream list is only enrichment. An entity we do not cover under
 * ANY of its five role addresses is staged as a candidate; if an upstream entry happens to describe
 * it, that name/logo/url rides along, and if not the candidate carries its address as its identity
 * and nothing is invented for it.
 *
 * ONLY LIVE ENTITIES. An entity that deregistered, or that has not been seen for more than
 * STALE_EPOCHS behind its network's head, is skipped: the registry archives departed providers
 * rather than listing them, and back-filling the long dead would undo that.
 */
const STALE_EPOCHS = 2;

export async function scanOnchainEntities(
  enrich: Map<string, { name: string; description: string; url: string; logoURI: string | null }> = new Map()
): Promise<Pick<ScanResult, "chainScanned" | "chainNewToUs" | "chainStaged" | "chainSkippedStale">> {
  const { ourAddrs, entities, rolesOf } = await coverageIndex();

  // Per-network head, taken from the data itself so this needs no clock or RPC.
  const head = new Map<string, number>();
  for (const e of entities) {
    head.set(e.network, Math.max(head.get(e.network) ?? 0, e.lastEpochSeen ?? 0));
  }

  const existing = await prisma.importCandidate.findMany();
  const candByKey = new Map(existing.map((c) => [`${c.chainId}:${c.address.toLowerCase()}`, c]));

  let chainNewToUs = 0;
  let chainStaged = 0;
  let chainSkippedStale = 0;

  for (const e of entities) {
    const roles = rolesOf(e);
    if (roles.some((r) => ourAddrs.has(r))) continue; // already covered
    chainNewToUs++;

    const behind = (head.get(e.network) ?? 0) - (e.lastEpochSeen ?? 0);
    if (!e.registered || behind > STALE_EPOCHS) {
      chainSkippedStale++;
      continue;
    }

    const chain = getChainByKey(e.network);
    if (!chain) continue;

    // Seed under the DELEGATION address when there is one. That is the address the feed's consumers
    // and the reward data key on, and it is the one an owner is most likely to sign with when they
    // come to claim; falling back to the voter keeps an entity with no delegation address listable.
    const addr = (e.delegationAddress ?? e.voter).toLowerCase();
    const key = `${chain.chainId}:${addr}`;
    if (candByKey.has(key)) continue; // already staged/actioned under this address

    // Enrichment if some upstream list happens to describe any of this entity's role addresses.
    // Otherwise the candidate carries the address as its name. Nothing is invented: an entity with
    // no published identity is shown as an address, which is exactly what is known about it.
    const meta = roles.map((r) => enrich.get(r)).find(Boolean);
    await prisma.importCandidate.create({
      data: {
        source: meta ? "onchain+bifrost" : "onchain",
        chainId: chain.chainId,
        address: addr,
        name: meta?.name ?? addr,
        description: meta?.description ?? "",
        url: meta?.url ?? "",
        logoURI: meta?.logoURI ?? null,
      },
    });
    chainStaged++;
  }

  return {
    chainScanned: entities.length,
    chainNewToUs,
    chainStaged,
    chainSkippedStale,
  };
}

/**
 * The scan the admin surface and cron actually call: upstream first (so its metadata is available as
 * enrichment), then the chain sweep that decides coverage.
 */
export async function scanImports(): Promise<ScanResult> {
  const upstream = await scanBifrostImports();

  // Re-read the upstream list from the candidates it just refreshed, keyed by address, so the chain
  // sweep can attach a name to an entity an upstream list describes under a different role address.
  const enrich = new Map<
    string,
    { name: string; description: string; url: string; logoURI: string | null }
  >();
  for (const c of await prisma.importCandidate.findMany({ where: { source: "bifrost" } })) {
    enrich.set(c.address.toLowerCase(), {
      name: c.name,
      description: c.description,
      url: c.url,
      logoURI: c.logoURI,
    });
  }

  const chain = await scanOnchainEntities(enrich);
  return { ...upstream, ...chain };
}
