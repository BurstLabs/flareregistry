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
const DEFAULT_MAX_BACKFILL = 12; // ~6 weeks of 3.5-day epochs

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
  const [info, dist] = await Promise.all([
    fetchJson(`${base}/reward-epoch-info.json`),
    fetchJson(`${base}/reward-distribution-data.json`),
  ]);
  if (!info || !dist) return null;
  try {
    return parseEpoch(info, dist, network);
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
      goodStanding: metric?.goodStanding ?? true,
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

  return { network, ingested, from: start, to: latest };
}

export async function ingestAll(maxBackfill?: number): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const network of NETWORKS) {
    results.push(await ingestNetwork(network, maxBackfill));
  }
  return results;
}
