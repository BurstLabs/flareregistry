// Ingestion service for the Flare-published fsp-rewards dataset. Fetches new reward-epoch
// folders, parses them (lib/fsp-rewards), and upserts per-provider identity + per-epoch
// metrics. Idempotent and incremental: only epochs past lastEpochIngested are fetched.
//
// No live RPC; history comes entirely from the committed files. See docs/evolved-registry-research.md.

import { prisma } from "./db";
import { parseEpoch, type ParsedEpoch } from "./fsp-rewards";

const RAW_BASE = "https://raw.githubusercontent.com/flare-foundation/fsp-rewards/main";
const API_BASE = "https://api.github.com/repos/flare-foundation/fsp-rewards/contents";

export const NETWORKS = ["flare", "songbird"] as const;
export type Network = (typeof NETWORKS)[number];

// Don't walk the entire history on first run by default; cap how far back we backfill.
// 30, not 12. The reward CLAIM window is about 25 epochs (rewardExpiryOffsetSeconds 7,776,000 over a
// 302,400s epoch), so a 12-epoch window cannot see the epochs closest to expiring.
const DEFAULT_MAX_BACKFILL = 30;

async function fetchJson(url: string): Promise<any | null> {
  const res = await fetch(url, {
    headers: process.env.GITHUB_ASSETS_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_ASSETS_TOKEN}` }
      : {},
  });
  if (!res.ok) return null;
  return res.json();
}

/** Highest epoch folder present for a network (lists the directory via the GitHub API). */
async function latestEpochOnRepo(network: Network): Promise<number | null> {
  const listing = await fetchJson(`${API_BASE}/${network}`);
  if (!Array.isArray(listing)) return null;
  const epochs = listing
    .filter((e) => e.type === "dir" && /^\d+$/.test(e.name))
    .map((e) => Number(e.name));
  return epochs.length ? Math.max(...epochs) : null;
}

async function getState(network: Network): Promise<number> {
  const s = await prisma.ingestState.findUnique({ where: { network } });
  return s?.lastEpochIngested ?? 0;
}

/** Fetch and parse one epoch, or null if its files are not present/complete. */
async function loadEpoch(network: Network, epochId: number): Promise<ParsedEpoch | null> {
  const base = `${RAW_BASE}/${network}/${epochId}`;
  const [info, dist, passes] = await Promise.all([
    fetchJson(`${base}/reward-epoch-info.json`),
    fetchJson(`${base}/reward-distribution-data.json`),
    // Minimal conditions. OPTIONAL: absent for older epochs and for the newest one or two, since
    // GitHub publication trails the chain. Its absence leaves goodStanding NULL, never true.
    fetchJson(`${base}/passes.json`),
  ]);
  if (!info || !dist) return null;
  try {
    return parseEpoch(info, dist, network, passes);
  } catch {
    return null;
  }
}

/** Upsert one parsed epoch's identities (latest snapshot) and per-epoch metrics. */
async function persistEpoch(parsed: ParsedEpoch): Promise<void> {
  const { network, epochId } = parsed;

  for (const m of parsed.metrics) {
    await prisma.providerMetricEpoch.upsert({
      where: { network_epochId_voter: { network, epochId, voter: m.voter } },
      create: { network, epochId, ...m },
      update: { ...m },
    });
  }

  // Identity snapshot: only advance to the latest epoch we've seen for that entity.
  for (const id of parsed.identities) {
    const existing = await prisma.providerOnchain.findUnique({
      where: { network_voter: { network, voter: id.voter } },
    });
    if (existing && existing.lastEpochSeen >= epochId) continue;

    const metric = parsed.metrics.find((x) => x.voter === id.voter);
    const data = {
      delegationAddress: id.delegationAddress,
      submitAddress: id.submitAddress,
      submitSignaturesAddress: id.submitSignaturesAddress,
      signingPolicyAddress: id.signingPolicyAddress,
      nodeIds: id.nodeIds,
      feeBips: id.feeBips,
      wNatWeight: id.wNatWeight,
      wNatCappedWeight: id.wNatCappedWeight,
      signingWeight: id.signingWeight,
      feedCount: metric?.feedCount ?? null,
      registered: true,
      // NULL, not true. Defaulting an unknown verdict to "in good standing" is the exact bug this
      // change exists to remove; it must not survive in the snapshot write.
      goodStanding: metric?.goodStanding ?? null,
      lastEpochSeen: epochId,
    };
    await prisma.providerOnchain.upsert({
      where: { network_voter: { network, voter: id.voter } },
      create: { network, voter: id.voter, ...data },
      update: data,
    });
  }
}

export interface IngestResult {
  network: Network;
  ingested: number[];
  from: number;
  to: number | null;
}

/** Ingest all new epochs for one network, up to maxBackfill on a cold start. */
export async function ingestNetwork(
  network: Network,
  maxBackfill = DEFAULT_MAX_BACKFILL
): Promise<IngestResult> {
  const latest = await latestEpochOnRepo(network);
  const last = await getState(network);
  const ingested: number[] = [];
  if (latest == null) return { network, ingested, from: last, to: null };

  // Cold start: don't backfill the entire history, just the most recent window.
  const start = last > 0 ? last + 1 : Math.max(1, latest - maxBackfill + 1);

  for (let epoch = start; epoch <= latest; epoch++) {
    const parsed = await loadEpoch(network, epoch);
    if (!parsed) continue; // skip missing/incomplete; a later run can catch it
    await persistEpoch(parsed);
    ingested.push(epoch);
    await prisma.ingestState.upsert({
      where: { network },
      create: { network, lastEpochIngested: epoch },
      update: { lastEpochIngested: epoch },
    });
  }

  // DEREGISTRATION SWEEP. An entity that stops operating simply stops appearing in
  // reward-epoch-info.json and its row is never touched again, so without this `registered` latches
  // true forever and feeds a public "Registered" badge on entities that left over a year ago.
  //
  // Only when the NEWEST published epoch was just persisted: during a backfill, marking everyone
  // absent from an old epoch as deregistered would wipe the column for the whole current field. The
  // size floor stops a truncated file deregistering the network in one run.
  if (ingested.length && ingested[ingested.length - 1] === latest) {
    const present = await prisma.providerMetricEpoch.count({ where: { network, epochId: latest } });
    if (present >= 20) {
      await prisma.providerOnchain.updateMany({
        where: { network, registered: true, lastEpochSeen: { lt: latest } },
        data: { registered: false },
      });
    }
  }

  return { network, ingested, from: start, to: latest };
}

export async function ingestAll(maxBackfill?: number): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const network of NETWORKS) {
    results.push(await ingestNetwork(network, maxBackfill));
  }
  return results;
}
