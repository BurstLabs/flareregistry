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
import { isSupportedChain } from "./chains";
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
  error?: string;
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

  // Our known addresses (by chain) so we can tell "new to us" from "already have".
  const ours = await prisma.providerAddress.findMany({ select: { chainId: true, address: true } });
  const ourKeys = new Set(ours.map((a) => `${a.chainId}:${a.address.toLowerCase()}`));

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

    if (ourKeys.has(key)) {
      // We already have this provider. If a stale candidate exists, mark it absorbed.
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
