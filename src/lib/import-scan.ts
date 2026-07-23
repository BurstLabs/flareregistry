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

  // Our known addresses. A provider registers ONE of its five on-chain role addresses (identity,
  // submit, submitSignatures, signingPolicy, delegation), but an upstream list may list the SAME
  // provider under a DIFFERENT role address - so an exact ProviderAddress match is not enough to say
  // "we have this". We must also treat as ours any role address of an on-chain entity we already list.
  // (Example: we list Quicknode by its identity address; TowoLabs lists it by its delegation address.)
  //
  // Match is by address alone (not chain-scoped): the five role addresses identify one operator, and
  // an upstream entry we'd import on network X is the same operator we already cover on network Y.
  const ours = await prisma.providerAddress.findMany({ select: { address: true } });
  const ourAddrs = new Set(ours.map((a) => a.address.toLowerCase()));

  // Every on-chain entity whose voter (or any role address) is one we already list; collect ALL of
  // that entity's role addresses so an upstream entry under any of them is recognised as ours.
  const entities = await prisma.providerOnchain.findMany({
    select: {
      voter: true,
      delegationAddress: true,
      submitAddress: true,
      submitSignaturesAddress: true,
      signingPolicyAddress: true,
    },
  });
  for (const e of entities) {
    const roles = [
      e.voter,
      e.delegationAddress,
      e.submitAddress,
      e.submitSignaturesAddress,
      e.signingPolicyAddress,
    ].filter((r): r is string => !!r);
    // If we already list this entity by ANY of its role addresses, mark every role address as ours.
    if (roles.some((r) => ourAddrs.has(r.toLowerCase()))) {
      for (const r of roles) ourAddrs.add(r.toLowerCase());
    }
  }

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
