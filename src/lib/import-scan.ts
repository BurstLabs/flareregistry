// Scan an external legacy provider list (the TowoLabs ftso-signal-providers list that wallets
// historically consumed) for entries NOT yet in our registry, and stage them as ImportCandidates for
// admin review. Approving a candidate creates an unclaimed source="imported" Provider that then
// follows the normal path (it lists only once it qualifies on-chain or the owner claims it).
//
// Design notes:
// - Dedupe key is (chainId, lowercased address), matched against our ProviderAddress rows AND existing
//   candidates, so an entry we already have (by any means) is never surfaced.
// - Only NEW-to-us entries are staged (scope decision: additions only, not upstream edits).
// - A dismissed candidate is kept as a tombstone so it is not re-surfaced on the next scan.
// - Candidates whose address later appears in our registry are auto-marked "absorbed".
import { prisma } from "./db";
import { isSupportedChain, getChainByKey } from "./chains";
import { isClean } from "./content-filter";

const TOWOLABS_LIST_URL =
  process.env.TOWOLABS_LIST_URL ??
  "https://raw.githubusercontent.com/TowoLabs/ftso-signal-providers/master/bifrost-wallet.providerlist.json";

interface UpstreamEntry {
  chainId: number;
  name: string;
  description: string;
  url: string;
  address: string;
  logoURI?: string;
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
export async function scanTowolabsImports(): Promise<ScanResult> {
  const result: ScanResult = { fetched: 0, newToUs: 0, staged: 0, refreshed: 0, absorbed: 0 };

  let list: { providers?: UpstreamEntry[] };
  try {
    const res = await fetch(TOWOLABS_LIST_URL, { cache: "no-store" });
    if (!res.ok) return { ...result, error: `upstream HTTP ${res.status}` };
    list = await res.json();
  } catch (e) {
    return { ...result, error: `fetch failed: ${(e as Error).message}` };
  }
  const providers = Array.isArray(list.providers) ? list.providers : [];
  result.fetched = providers.length;

  // Match is by address alone (not chain-scoped): the five role addresses identify one operator, and
  // an upstream entry we'd import on network X is the same operator we already cover on network Y.
  const { ourAddrs } = await coverageIndex();

  // Existing candidates, keyed the same way, so we update snapshots / auto-absorb rather than dupe.
  const existing = await prisma.importCandidate.findMany();
  const candByKey = new Map(existing.map((c) => [`${c.chainId}:${c.address.toLowerCase()}`, c]));

  const now = new Date();
  const seenThisRun = new Set<string>();

  for (const p of providers) {
    if (!p || !isSupportedChain(p.chainId) || typeof p.address !== "string") continue;
    const addr = p.address.toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(addr)) continue;
    const key = `${p.chainId}:${addr}`;
    seenThisRun.add(key);

    // Skip content that fails our filter (defensive - upstream is trusted, but names feed our UI).
    const name = clamp(p.name, 80);
    if (!name || !isClean(name)) continue;

    const snapshot = {
      name,
      description: clamp(p.description, 600),
      url: clamp(p.url, 200),
      logoURI: typeof p.logoURI === "string" ? p.logoURI.slice(0, 300) : null,
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
        data: { source: "towolabs", chainId: p.chainId, address: addr, ...snapshot },
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
 * scanTowolabsImports above can only ever surface providers that some other project already chose to
 * write down. That made the registry's real boundary "whoever is in the TowoLabs list", which is a
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
        source: meta ? "onchain+towolabs" : "onchain",
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
  const upstream = await scanTowolabsImports();

  // Re-read the upstream list from the candidates it just refreshed, keyed by address, so the chain
  // sweep can attach a name to an entity an upstream list describes under a different role address.
  const enrich = new Map<
    string,
    { name: string; description: string; url: string; logoURI: string | null }
  >();
  for (const c of await prisma.importCandidate.findMany({ where: { source: "towolabs" } })) {
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
