// Ingest P-chain validator rewards per reward epoch from Flare's reward-scripts repository, so the
// yield feed's networkRates can count what P-chain stakers earn from ValidatorRewardManager next to
// what they earn from FSP MIRROR claims. Network-wide totals only; Flare only (Songbird has no
// P-chain staking).
//
//   node scripts/ingest-validator-rewards.mjs              # fill any missing epoch in the last 30
//   node scripts/ingest-validator-rewards.mjs --backfill 60
//   node scripts/ingest-validator-rewards.mjs --refresh    # re-read stored epochs in the window too
//
// Runs on the same schedule as ingest-fsp-rewards.mjs, right after it. reward-scripts computes an
// epoch from fsp-rewards' minimal-conditions.json, so it is published after fsp-rewards for the same
// epoch (measured: 1 to 18 hours later, one commit per file, never revised). Until it is, the epoch
// is simply absent here and the feed says includesValidatorRewards: false. A not-yet-published epoch
// is a 404 and costs one request per run.
//
// Source: https://github.com/flare-foundation/reward-scripts/tree/main/generated-files
// Parse and checks: scripts/validator-rewards-parse.mjs (asserted in the build).

import { PrismaClient } from "@prisma/client";
import { summariseValidatorRewards } from "./validator-rewards-parse.mjs";

const RAW_BASE = "https://raw.githubusercontent.com/flare-foundation/reward-scripts/main/generated-files";
const NETWORK = "flare";
const argAt = process.argv.indexOf("--backfill");
const BACKFILL = argAt > -1 ? Number(process.argv[argAt + 1]) : 30;
const REFRESH = process.argv.includes("--refresh");

const prisma = new PrismaClient();
const auth = process.env.GITHUB_ASSETS_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_ASSETS_TOKEN}` } : {};

/** Parsed JSON, null on 404 (not published yet), throws on anything else so a run never stores half an epoch. */
async function getJson(url) {
  const r = await fetch(url, { headers: auth, signal: AbortSignal.timeout(60_000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function main() {
  if (!Number.isInteger(BACKFILL) || BACKFILL < 1) throw new Error("--backfill takes a positive whole number");
  // The newest epoch that matters is the newest one the fsp-rewards ingest has stored: the feed's
  // window ends there. reward-scripts never publishes an epoch before fsp-rewards does, but one past
  // it is probed as well so the order of the two cron steps does not matter.
  const state = await prisma.ingestState.findUnique({ where: { network: NETWORK } });
  const newest = (state?.lastEpochIngested ?? 0) + 1;
  if (newest <= 1) {
    console.log(`${NETWORK}: no fsp-rewards epoch ingested yet; nothing to do`);
    return;
  }
  const lo = Math.max(1, newest - BACKFILL + 1);
  const stored = new Set(
    (
      await prisma.validatorRewardEpoch.findMany({
        where: { network: NETWORK, epochId: { gte: lo, lte: newest } },
        select: { epochId: true },
      })
    ).map((r) => r.epochId),
  );

  let added = 0;
  let pending = 0;
  let refused = 0;
  for (let epochId = lo; epochId <= newest; epochId++) {
    if (stored.has(epochId) && !REFRESH) continue;
    const base = `${RAW_BASE}/reward-epoch-${epochId}`;
    let data, nodes;
    try {
      [data, nodes] = await Promise.all([getJson(`${base}/data.json`), getJson(`${base}/nodes-data.json`)]);
    } catch (e) {
      console.error(`${NETWORK}: validator rewards epoch ${epochId}: ${e.message}`);
      refused++;
      continue;
    }
    if (!data || !nodes) {
      pending++;
      continue;
    }
    const s = summariseValidatorRewards(epochId, data, nodes);
    if (!s.ok) {
      console.error(`${NETWORK}: validator rewards refused, ${s.reason}`);
      refused++;
      continue;
    }
    const { epochId: _e, ...fields } = s.value;
    await prisma.validatorRewardEpoch.upsert({
      where: { network_epochId: { network: NETWORK, epochId } },
      create: { network: NETWORK, epochId, ...fields },
      update: fields,
    });
    added++;
  }
  console.log(
    `${NETWORK}: validator rewards stored ${added} epoch(s) [${lo}..${newest}], ${pending} not published yet, ${refused} refused`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
