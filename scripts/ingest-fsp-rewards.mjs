// Run the fsp-rewards ingestion. Use for the initial backfill, manual runs, and the cron.
//
//   node scripts/ingest-fsp-rewards.mjs            # incremental (default backfill window)
//   node scripts/ingest-fsp-rewards.mjs --backfill 30
//
// This .mjs mirrors src/lib/ingest.ts + src/lib/fsp-rewards.ts so it runs without a TS build.
// Keep the parse logic in sync with those modules.

import { PrismaClient } from "@prisma/client";

const RAW_BASE = "https://raw.githubusercontent.com/flare-foundation/fsp-rewards/main";
const API_BASE = "https://api.github.com/repos/flare-foundation/fsp-rewards/contents";
const NETWORKS = ["flare", "songbird"];
const arg = process.argv.indexOf("--backfill");
// 30, not 12. The reward CLAIM window is about 25 epochs (rewardExpiryOffsetSeconds 7,776,000 over a
// 302,400s epoch), so a 12-epoch backfill cannot see the epochs closest to expiring, which are the
// only ones where being able to see them still matters.
const MAX_BACKFILL = arg > -1 ? Number(process.argv[arg + 1]) : 30;

const prisma = new PrismaClient();
const auth = process.env.GITHUB_ASSETS_TOKEN
  ? { Authorization: `Bearer ${process.env.GITHUB_ASSETS_TOKEN}` }
  : {};
const low = (a) => (typeof a === "string" && a ? a.toLowerCase() : null);

async function getJson(url) {
  const r = await fetch(url, { headers: auth });
  return r.ok ? r.json() : null;
}

async function latestEpoch(network) {
  const l = await getJson(`${API_BASE}/${network}`);
  if (!Array.isArray(l)) return null;
  const e = l.filter((x) => x.type === "dir" && /^\d+$/.test(x.name)).map((x) => Number(x.name));
  return e.length ? Math.max(...e) : null;
}

function parseEpoch(info, dist, network, passes, conds) {
  const epochId = info.rewardEpochId ?? dist.rewardEpochId;
  // signingPolicy.voters are signingPolicyAddresses (not identity voters); map by that.
  const sp = (info.signingPolicy?.voters ?? []).map((v) => v.toLowerCase());
  const sw = info.signingPolicy?.weights ?? [];
  const swByPolicyAddr = new Map();
  sp.forEach((a, i) => sw[i] !== undefined && swByPolicyAddr.set(a, String(sw[i])));
  const feedCount = Array.isArray(info.canonicalFeedOrder) ? info.canonicalFeedOrder.length : null;
  const epochThreshold = info.signingPolicy?.threshold != null ? String(info.signingPolicy.threshold) : null;

  const identities = [];
  const addrToVoter = new Map();
  for (const e of info.voterRegistrationInfo ?? []) {
    const r = e.voterRegistered ?? {};
    const vri = e.voterRegistrationInfo ?? {};
    const voter = low(r.voter ?? vri.voter);
    if (!voter) continue;
    const id = {
      voter,
      delegationAddress: low(vri.delegationAddress),
      submitAddress: low(r.submitAddress),
      submitSignaturesAddress: low(r.submitSignaturesAddress),
      signingPolicyAddress: low(r.signingPolicyAddress),
      nodeIds: Array.isArray(vri.nodeIds) ? vri.nodeIds.map((n) => n.toLowerCase()) : [],
      feeBips: typeof vri.delegationFeeBIPS === "number" ? vri.delegationFeeBIPS : null,
      wNatWeight: vri.wNatWeight != null ? String(vri.wNatWeight) : null,
      wNatCappedWeight: vri.wNatCappedWeight != null ? String(vri.wNatCappedWeight) : null,
      signingWeight: swByPolicyAddr.get(low(r.signingPolicyAddress) ?? "") ?? null,
    };
    identities.push(id);
    for (const a of [
      voter,
      id.delegationAddress,
      id.submitAddress,
      id.submitSignaturesAddress,
      id.signingPolicyAddress,
      ...id.nodeIds,
    ])
      if (a) addrToVoter.set(a, voter);
  }

  const fee = new Map(),
    del = new Map(),
    stk = new Map();
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0n) + BigInt(v));
  for (const c of dist.rewardClaims ?? []) {
    const b = c.body ?? c;
    const ben = low(b.beneficiary);
    if (!ben) continue;
    const v = addrToVoter.get(ben);
    if (!v) continue;
    if (b.claimType === 1) add(fee, v, String(b.amount));
    else if (b.claimType === 2) add(del, v, String(b.amount));
    else if (b.claimType === 3) add(stk, v, String(b.amount));
  }

  // voterAddress -> proportional minimal conditions for this epoch.
  const cond = new Map();
  for (const c of Array.isArray(conds) ? conds : []) {
    const v = low(c.voterAddress);
    if (!v) continue;
    const n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    cond.set(v, {
      ftsoHits: n(c.ftsoScaling?.totalHits),
      ftsoPossible: n(c.ftsoScaling?.allPossibleHits),
      fdcRounds: n(c.fdc?.rewardedVotingRounds),
      fdcTotal: n(c.fdc?.totalRewardedVotingRounds),
      // expectedUpdates arrives as a decimal STRING, not a number.
      fastUpdates: n(c.fastUpdates?.updates),
      fastExpected: c.fastUpdates?.expectedUpdates != null ? Number(c.fastUpdates.expectedUpdates) : null,
      ftsoMet: typeof c.ftsoScaling?.conditionMet === "boolean" ? c.ftsoScaling.conditionMet : null,
      fdcMet: typeof c.fdc?.conditionMet === "boolean" ? c.fdc.conditionMet : null,
      fastMet: typeof c.fastUpdates?.conditionMet === "boolean" ? c.fastUpdates.conditionMet : null,
      stakingOk: typeof c.staking?.conditionMet === "boolean" ? c.staking.conditionMet : null,
      strikes: n(c.strikes),
      passesHeld: n(c.passesHeld),
    });
  }

  // voterAddress -> pass/eligibility verdict for this epoch.
  const pass = new Map();
  for (const p of Array.isArray(passes) ? passes : []) {
    const v = low(p.voterAddress);
    if (!v) continue;
    pass.set(v, {
      eligible: typeof p.eligibleForReward === "boolean" ? p.eligibleForReward : null,
      passes: typeof p.passes === "number" ? p.passes : null,
      failures: Array.isArray(p.failures) ? p.failures.map((f) => f.failureId).filter(Boolean) : [],
    });
  }

  const metrics = identities.map((id) => ({
    voter: id.voter,
    feeBips: id.feeBips,
    wNatWeight: id.wNatWeight,
    wNatCappedWeight: id.wNatCappedWeight,
    signingWeight: id.signingWeight,
    feedCount,
    epochThreshold,
    feeReward: (fee.get(id.voter) ?? 0n).toString(),
    delegatorReward: (del.get(id.voter) ?? 0n).toString(),
    stakerReward: (stk.get(id.voter) ?? 0n).toString(),
    registered: true,
    // From passes.json, verbatim. Was hardcoded true, which reported every provider as in good
    // standing during epochs where Flare had burned all of their rewards.
    goodStanding: pass.get(id.voter)?.eligible ?? null,
    passes: pass.get(id.voter)?.passes ?? null,
    failures: pass.get(id.voter)?.failures ?? [],
    ...(cond.get(id.voter) ?? {}),
  }));
  return { epochId, network, identities, metrics };
}

async function persist(parsed) {
  const { network, epochId } = parsed;
  for (const m of parsed.metrics) {
    await prisma.providerMetricEpoch.upsert({
      where: { network_epochId_voter: { network, epochId, voter: m.voter } },
      create: { network, epochId, ...m },
      update: { ...m },
    });
  }
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

async function ingestNetwork(network) {
  const latest = await latestEpoch(network);
  if (latest == null) {
    console.log(`${network}: could not list repo`);
    return;
  }
  const state = await prisma.ingestState.findUnique({ where: { network } });
  const last = state?.lastEpochIngested ?? 0;
  const start = last > 0 ? last + 1 : Math.max(1, latest - MAX_BACKFILL + 1);
  let n = 0;
  let lastPersisted = null;
  for (let epoch = start; epoch <= latest; epoch++) {
    const base = `${RAW_BASE}/${network}/${epoch}`;
    const [info, dist, passes, conds] = await Promise.all([
      getJson(`${base}/reward-epoch-info.json`),
      getJson(`${base}/reward-distribution-data.json`),
      // Minimal conditions. OPTIONAL: absent for older epochs and for the newest one or two, since
      // GitHub publication trails the chain. Its absence must leave goodStanding NULL, never true.
      getJson(`${base}/passes.json`),
      // Proportional minimal conditions. Same folder, same optionality as passes.json: absent for
      // older epochs, and its absence must leave the rates NULL rather than zero.
      getJson(`${base}/minimal-conditions.json`),
    ]);
    if (!info || !dist) continue;
    await persist(parseEpoch(info, dist, network, passes, conds));
    await prisma.ingestState.upsert({
      where: { network },
      create: { network, lastEpochIngested: epoch },
      update: { lastEpochIngested: epoch },
    });
    n++;
    lastPersisted = epoch;
  }
  // DEREGISTRATION SWEEP.
  //
  // An entity that stops operating simply stops appearing in reward-epoch-info.json. Nothing else
  // ever touches its row, so without this `registered` is a latching true: it goes up and never comes
  // down. Measured before the fix: 179 rows on a network with 100 seats, every one of them true,
  // including entities last seen at epoch 231 against a current 422. That fed a public "Registered"
  // badge on their provider pages and scored them as if they were live but failing.
  //
  // Only sweep when we have just persisted the NEWEST published epoch. During a backfill the loop
  // walks old epochs, and marking everyone absent from epoch 250 as deregistered would wipe the
  // column for the entire current field.
  //
  // The size floor is the same guard used by the Management Group sync: a truncated or partial file
  // must not be able to deregister the whole network in one run.
  if (lastPersisted === latest && n > 0) {
    const present = await prisma.providerMetricEpoch.count({ where: { network, epochId: latest } });
    if (present >= 20) {
      const gone = await prisma.providerOnchain.updateMany({
        where: { network, registered: true, lastEpochSeen: { lt: latest } },
        data: { registered: false },
      });
      if (gone.count) console.log(`${network}: ${gone.count} entity(ies) no longer registered at epoch ${latest}`);
    } else {
      console.log(`${network}: only ${present} entities in epoch ${latest}; skipping deregistration sweep`);
    }
  }

  console.log(`${network}: ingested ${n} epoch(s) [${start}..${latest}]`);
}

async function main() {
  for (const net of NETWORKS) await ingestNetwork(net);
  const onchain = await prisma.providerOnchain.count();
  const metrics = await prisma.providerMetricEpoch.count();
  console.log(`totals: ${onchain} entities, ${metrics} epoch-metric rows`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
