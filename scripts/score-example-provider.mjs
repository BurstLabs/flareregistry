// Example-provider probability scorer (FLARE ONLY).
//
// Each run processes recently-settled voting rounds and, per round:
//   1. Reads our reference example-provider instances' values (ReferenceSample rows, collected live by
//      collect-reference.mjs) for that round.
//   2. Decodes every provider's on-chain REVEALED values from Submission calldata via our RPC.
//   3. Classifies feeds as DISCRIMINATING by observed cross-provider dispersion (liquid feeds where
//      everyone agrees carry no signal; the score uses only feeds where providers actually diverge).
//   4. For each provider, measures how tightly its discriminating-feed values track our reference
//      instances RELATIVE to the field baseline, and folds that into rolling EW accumulators.
//
// It never stores raw per-round values - only the ProviderSimilarity rolling summaries. The reference
// instances' mutual disagreement sets the non-determinism floor used to calibrate.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const RPC = process.env.FLARE_RPC_URL ?? "https://flare-api.flare.network/ext/C/rpc";
const SUBMISSION = (process.env.SUBMISSION_ADDR ?? "0x2cA6571Daa15ce734Bbd0Bf27D5C9D16787fc33f").toLowerCase();
const FTSO_PROTOCOL_ID = 100;
const FIRST_VOTING_ROUND_TS = 1658429955;
const VOTING_EPOCH_DURATION = 90;
const REVEAL_SELECTOR = "0x9d00c9fd"; // submit2 (reveal) on Flare
// EW smoothing for the rolling accumulators (~ decays over a few hundred rounds).
const EW_ALPHA = 0.02;
// A feed is "discriminating" this round if the coefficient-of-variation of provider values exceeds
// this. Below it, everyone agrees (liquid) and it carries no signal.
const DISCRIMINATING_CV = 0.0008;
// A value is an EXCURSION when it sits this many MADs from the network median (a sharp spike away from
// consensus). Providers running the same shared-source code excursion together on the same feeds/rounds.
const EXCURSION_K = 4;

const FSP_BASE = "https://raw.githubusercontent.com/flare-foundation/fsp-rewards/main/flare";
const REWARD_EPOCH_DURATION_ROUNDS = 3360; // 3.5 days / 90s

// Decode a feed id (hex) -> "NAME" (category byte dropped; we key by name, matching reference config).
function feedIdToName(idHex) {
  const b = Buffer.from(idHex.slice(2), "hex");
  return b.subarray(1).toString("ascii").replace(/\0+$/, "");
}

// Canonical feed order (index -> {name, decimals}) for the reward epoch covering a voting round. This
// is the PROTOCOL order the reveal value array uses - it is NOT the example provider's config order, so
// we must map by this to align reveal indices with feed names. Cached per reward epoch.
const canonicalCache = new Map();
async function canonicalFeeds(round) {
  const rewardEpoch = Math.floor(round / REWARD_EPOCH_DURATION_ROUNDS);
  // The reward-epoch NUMBER in fsp-rewards is not round/3360 directly; find it by trying nearby epochs.
  // Simpler + robust: the info file is per reward epoch dir; we locate the epoch whose range covers the
  // round via the reward-epoch-info's votingRoundId range if present. Fall back to scanning recent dirs.
  if (canonicalCache.has("resolved")) return canonicalCache.get("resolved");
  // Reward-epoch dirs (newest first). The epoch covering the CURRENT round may not be published yet,
  // so: pick the epoch whose voting-round range contains `round`; if none (round is in an in-progress
  // epoch past the latest published), fall back to the NEWEST published epoch's order - canonicalFeedOrder
  // changes only at epoch boundaries and is stable across adjacent epochs, so this is safe for scoring.
  const eps = await candidateEpochs();
  let newest = null;
  for (const ep of eps) {
    try {
      const r = await fetch(`${FSP_BASE}/${ep}/reward-epoch-info.json`, { cache: "no-store" });
      if (!r.ok) continue;
      const info = await r.json();
      if (!Array.isArray(info.canonicalFeedOrder)) continue;
      const feeds = info.canonicalFeedOrder.map((f) => ({ name: feedIdToName(f.id), decimals: f.decimals ?? 5 }));
      const start = info.expectedStartVotingRoundId ?? info.signingPolicy?.startVotingRoundId;
      const end = info.expectedEndVotingRoundId ?? info.endVotingRoundId;
      if (newest == null) newest = feeds; // eps is newest-first
      if (start != null && round >= start && (end == null || round <= end)) {
        canonicalCache.set("resolved", feeds);
        return feeds;
      }
    } catch { /* try next */ }
  }
  if (newest) canonicalCache.set("resolved", newest);
  return newest;
}

// Candidate reward-epoch dir numbers to probe for a given voting round: list the fsp-rewards flare dir
// and return numeric epoch names, newest first (bounded).
let epochListCache = null;
async function candidateEpochs() {
  if (epochListCache) return epochListCache;
  try {
    const r = await fetch("https://api.github.com/repos/flare-foundation/fsp-rewards/contents/flare", { cache: "no-store" });
    const arr = await r.json();
    epochListCache = arr.filter((x) => /^\d+$/.test(x.name)).map((x) => +x.name).sort((a, b) => b - a).slice(0, 6);
  } catch {
    epochListCache = [];
  }
  return epochListCache;
}

let rpcId = 0;
// Retry transient RPC failures. The reveal decoder makes hundreds of block fetches per round, and the
// public Flare RPC intermittently times out under that load; without retries one hiccup aborts the whole
// run and the tab goes empty. Exponential backoff, small jitter via attempt index.
async function rpc(method, params, attempt = 0) {
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  } catch (e) {
    if (attempt >= 5) throw e;
    await new Promise((res) => setTimeout(res, 300 * 2 ** attempt + attempt * 50));
    return rpc(method, params, attempt + 1);
  }
}

// --- calldata decode (mirrors FTSO-Scaling PayloadMessage + FeedValueEncoder) ---
function decodePayloads(inputHex) {
  const b = Buffer.from(inputHex.slice(10), "hex"); // drop 0x + 4-byte selector
  const msgs = [];
  let i = 0;
  while (i + 7 <= b.length) {
    const pid = b[i];
    const round = b.readUInt32BE(i + 1);
    const len = b.readUInt16BE(i + 5);
    const payload = b.subarray(i + 7, i + 7 + len);
    msgs.push({ pid, round, payload });
    i += 7 + len;
  }
  return msgs;
}
// Reveal payload = random(32) ++ values(4 bytes each). On-chain int = round(value*10^dec)+2^31.
// We can't recover `decimals` from calldata alone, but for SIMILARITY we don't need the real scale:
// the raw 4-byte int is a monotonic stand-in per feed, and all providers use the same encoding, so
// comparing raw ints per feed is equivalent to comparing values. Reference values are converted to the
// same raw space per feed using the per-round provider median scale (see scorer).
function decodeReveal(payload) {
  if (payload.length < 32) return null;
  const vals = payload.subarray(32);
  const n = Math.floor(vals.length / 4);
  const out = [];
  for (let k = 0; k < n; k++) out.push(vals.readUInt32BE(k * 4));
  return out; // array of raw uint32, index = canonical feed order
}

function currentRound() {
  return Math.floor((Math.floor(Date.now() / 1000) - FIRST_VOTING_ROUND_TS) / VOTING_EPOCH_DURATION);
}

// Collect all providers' revealed raw-int arrays for a given round by scanning the blocks whose
// timestamps fall in that round's reveal window. Returns Map<providerAddr, uint32[]>.
async function blockAtOrAfterTs(targetTs, latestBlock) {
  // Binary search for the lowest block whose timestamp >= targetTs.
  let lo = 1, hi = latestBlock, ans = latestBlock;
  const tsCache = new Map();
  const tsOf = async (b) => {
    if (tsCache.has(b)) return tsCache.get(b);
    const blk = await rpc("eth_getBlockByNumber", [`0x${b.toString(16)}`, false]);
    const t = parseInt(blk.timestamp, 16);
    tsCache.set(b, t);
    return t;
  };
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((await tsOf(mid)) >= targetTs) { ans = mid; hi = mid - 1; }
    else lo = mid + 1;
  }
  return ans;
}

async function revealsForRound(round, latestBlock) {
  // Reveal for round R happens during round R+1. Find the exact block range by timestamp (binary
  // search), not a block-time estimate - the estimate under-captured reveals on some rounds.
  const revealStartTs = FIRST_VOTING_ROUND_TS + (round + 1) * VOTING_EPOCH_DURATION;
  const revealEndTs = revealStartTs + VOTING_EPOCH_DURATION;
  const byProvider = new Map();
  const startBlock = await blockAtOrAfterTs(revealStartTs, latestBlock);
  const endBlock = await blockAtOrAfterTs(revealEndTs + 1, latestBlock);
  for (let b = startBlock; b <= endBlock; b++) {
    const blk = await rpc("eth_getBlockByNumber", [`0x${b.toString(16)}`, true]);
    const ts = parseInt(blk.timestamp, 16);
    if (ts < revealStartTs) continue;
    if (ts > revealEndTs) break;
    for (const tx of blk.transactions) {
      if (!tx.to || tx.to.toLowerCase() !== SUBMISSION) continue;
      if (!tx.input.startsWith(REVEAL_SELECTOR)) continue;
      for (const m of decodePayloads(tx.input)) {
        if (m.pid !== FTSO_PROTOCOL_ID || m.round !== round) continue;
        const vals = decodeReveal(m.payload);
        if (vals) byProvider.set(tx.from.toLowerCase(), vals);
      }
    }
  }
  return byProvider;
}

async function main() {
  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const cur = currentRound();
  // Drive off the rounds we actually HAVE reference samples for, that are also SETTLED (reveal for
  // round R completes during R+1, so R must be <= cur-2). Take the most recent few unscored such rounds.
  const sampled = await prisma.referenceSample.groupBy({
    by: ["round"],
    where: { round: { lte: cur - 2 } },
    orderBy: { round: "desc" },
    take: 3,
  });
  const rounds = sampled.map((s) => s.round).sort((a, b) => a - b);
  if (rounds.length === 0) {
    console.log(`no settled reference rounds yet (cur=${cur}); need samples for a round <= ${cur - 2}`);
    await prisma.$disconnect();
    return;
  }

  for (const round of rounds) {
    // Isolate each round: a round that fails (even after RPC retries) is skipped, never aborts the run,
    // so a transient hiccup can't wipe the whole pass and leave the tab empty.
    try {
      const refs = await prisma.referenceSample.findMany({ where: { round } });
      if (refs.length === 0) continue;
      const reveals = await revealsForRound(round, latest);
      if (reveals.size === 0) {
        console.log(`round ${round}: no reveals decoded, skip`);
        continue;
      }
      const canonical = await canonicalFeeds(round);
      if (!canonical) { console.log(`round ${round}: no canonical feed order, skip`); continue; }
      await scoreRound(round, refs, reveals, canonical);
      console.log(`round ${round}: scored ${reveals.size} providers against ${refs.length} ref instances`);
    } catch (e) {
      console.error(`round ${round}: failed, skipping - ${e.message}`);
    }
  }
  await prisma.$disconnect();
}

const OFFSET = 0x80000000; // 2^31, the encoder's zero point
const decodeValue = (raw, decimals) => (raw - OFFSET) / 10 ** decimals; // raw uint32 -> real price

// Scoring for one round. reveals index i corresponds to canonical[i] = {name, decimals}. We decode each
// provider's raw ints to REAL values via decimals, then compare (per feed, in real-value space) each
// provider to our reference instances vs the field median. Signal lives on DISCRIMINATING feeds (where
// providers actually disagree); liquid feeds where everyone converges carry none.
// Variant of a reference instance id "variant:n" -> "variant".
const variantOf = (instanceId) => String(instanceId).split(":")[0];

async function scoreRound(round, refs, reveals, canonical) {
  const providers = [...reveals.entries()];
  const nFeeds = Math.min(canonical.length, ...providers.map(([, v]) => v.length));

  // Group reference samples by variant (full|top5|top10). Each variant is matched independently; a
  // provider's probability comes from the BEST-matching variant, which also reveals their likely config.
  const byVariant = new Map();
  for (const r of refs) {
    const vk = variantOf(r.instance);
    if (!byVariant.has(vk)) byVariant.set(vk, []);
    byVariant.get(vk).push(r);
  }

  // Per feed: decode all providers' real values, compute median, dispersion, and a robust MAD used for
  // EXCURSION detection (a value is an "excursion" when it sits > EXCURSION_K MADs from the median - a
  // sharp deviation from the network consensus this round).
  const perFeed = [];
  for (let f = 0; f < nFeeds; f++) {
    const { name, decimals } = canonical[f];
    const vals = providers
      .map(([, v]) => decodeValue(v[f], decimals))
      .filter((x) => Number.isFinite(x) && x > 0);
    if (vals.length < 5) { perFeed.push(null); continue; }
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || median * 1e-9;
    const relSpread = median > 0 ? sd / median : 0; // fractional cross-provider disagreement
    // MAD (median absolute deviation), scaled; the robust spread for excursion flagging.
    const absDev = vals.map((x) => Math.abs(x - median)).sort((a, b) => a - b);
    const mad = (absDev[Math.floor(absDev.length / 2)] || median * 1e-9) * 1.4826;
    perFeed.push({ name, median, sd, mad, relSpread, discriminating: relSpread > DISCRIMINATING_CV });
  }

  // Excursion of a single value on feed f: {sign:-1|0|1, mag} where mag is deviation in MADs. sign 0 =
  // within band (not an excursion). Only discriminating feeds carry signal.
  function excursion(f, val) {
    const pf = perFeed[f];
    if (!pf || !pf.discriminating || !Number.isFinite(val) || val <= 0) return { sign: 0, mag: 0 };
    const z = (val - pf.median) / (pf.mad || 1);
    if (Math.abs(z) < EXCURSION_K) return { sign: 0, mag: Math.abs(z) };
    return { sign: Math.sign(z), mag: Math.abs(z) };
  }

  // Similarity of a target value series against a per-feed reference-value set, over discriminating
  // feeds. `getVal(f)` -> target's real value; `refSet(f)` -> array of reference values for feed f.
  function similarityOf(getVal, refSet) {
    let simSum = 0, devSum = 0, cnt = 0;
    for (let f = 0; f < nFeeds; f++) {
      const pf = perFeed[f];
      if (!pf || !pf.discriminating) continue;
      const val = getVal(f);
      if (!Number.isFinite(val) || val <= 0) continue;
      const rr = refSet(f);
      if (!rr || rr.length === 0) continue;
      const fieldDist = Math.abs(val - pf.median) / pf.sd;
      const refDist = Math.min(...rr.map((r) => Math.abs(val - r))) / pf.sd;
      simSum += fieldDist - refDist;
      devSum += fieldDist;
      cnt++;
    }
    return { sim: cnt ? simSum / cnt : null, dev: cnt ? devSum / cnt : null, cnt };
  }

  const now = new Date();
  // Load all variants' calibration state up front.
  const variantKeys = [...byVariant.keys()];
  const cals = new Map();
  for (const vk of variantKeys) {
    cals.set(
      vk,
      (await prisma.detectionCalibration.findUnique({ where: { id: vk } })) ??
        { anchorMean: 0, anchorVar: 0.01, anchorN: 0, fieldMean: 0, fieldVar: 0.01, fieldN: 0 }
    );
  }

  // Per-variant reference value sets + this round's anchor samples (each instance scored vs its OWN
  // variant's other instances). Field samples accumulate per variant from the provider sims below.
  const anchorByVariant = new Map(); // vk -> number[]
  const fieldByVariant = new Map(); // vk -> number[]
  const refSetByVariant = new Map(); // vk -> (f)=>values[]
  for (const vk of variantKeys) {
    const vinsts = byVariant.get(vk);
    refSetByVariant.set(vk, (f) =>
      vinsts.map((r) => r.values[perFeed[f]?.name]).filter((x) => Number.isFinite(x) && x > 0)
    );
    const anchor = [];
    for (let i = 0; i < vinsts.length; i++) {
      const self = vinsts[i].values;
      const others = vinsts.filter((_, j) => j !== i);
      const s = similarityOf(
        (f) => self[perFeed[f]?.name],
        (f) => others.map((o) => o.values[perFeed[f]?.name]).filter((x) => Number.isFinite(x) && x > 0)
      );
      if (s.sim != null) anchor.push(s.sim);
    }
    anchorByVariant.set(vk, anchor);
    fieldByVariant.set(vk, []);
  }

  // --- REFERENCE EXCURSION SIGNATURE for this round ---
  // For each discriminating feed, does OUR reference example provider excursion from the network median,
  // and which direction? Use the reference median value across ALL instances (variants included) as the
  // reference position on that feed. refExcursion[f] = sign in {-1,0,1}; sign 0 = no reference excursion.
  const refExcursion = new Array(nFeeds).fill(0);
  const refExcursionFeeds = [];
  for (let f = 0; f < nFeeds; f++) {
    const pf = perFeed[f];
    if (!pf || !pf.discriminating) continue;
    const rv = refs.map((r) => r.values[pf.name]).filter((x) => Number.isFinite(x) && x > 0);
    if (rv.length === 0) continue;
    const refMed = [...rv].sort((a, b) => a - b)[Math.floor(rv.length / 2)];
    const e = excursion(f, refMed);
    if (e.sign !== 0) { refExcursion[f] = e.sign; refExcursionFeeds.push(f); }
  }

  // Co-excursion of a target on the feeds where the REFERENCE excursioned this round: fraction where the
  // target excursioned the SAME direction. Returns {matches, opps} to accumulate a rate. Only meaningful
  // when the reference actually excursioned somewhere (refExcursionFeeds non-empty).
  function coExcursionOf(getVal) {
    let matches = 0, opps = 0;
    for (const f of refExcursionFeeds) {
      const e = excursion(f, getVal(f));
      opps++;
      if (e.sign === refExcursion[f]) matches++;
    }
    return { matches, opps };
  }

  // Score each provider against every variant. Select the best variant by RAW SIMILARITY (closest fit),
  // NOT by posterior: the posterior is variance-sensitive, and a narrower-exchange variant has a tighter
  // anchor, so max-posterior would make that variant a catch-all that absorbs almost everyone regardless
  // of genuine fit. Pick the variant the provider's values actually sit closest to, THEN compute the
  // probability from that variant's calibration.
  for (const [addr, v] of providers) {
    let best = null;
    for (const vk of variantKeys) {
      const s = similarityOf(
        (f) => decodeValue(v[f], canonical[f].decimals),
        refSetByVariant.get(vk)
      );
      if (s.cnt === 0 || s.sim == null) continue;
      fieldByVariant.get(vk).push(s.sim);
      if (!best || s.sim > best.sim) best = { vk, sim: s.sim, dev: s.dev };
    }
    if (!best) continue;
    // Probability from the SELECTED variant's calibration.
    best.prob = posteriorExample(best.sim, cals.get(best.vk));

    // Co-excursion: on feeds where our reference excursioned this round, did this provider excursion the
    // same way? (Only contributes when the reference excursioned somewhere.)
    const co = coExcursionOf((f) => decodeValue(v[f], canonical[f].decimals));

    const existing = await prisma.providerSimilarity.findUnique({
      where: { network_voter: { network: "flare", voter: addr } },
    });
    let mean, varr, dev, rounds, coRate, coN;
    if (!existing) {
      mean = best.sim; varr = 0; dev = best.dev; rounds = 1;
      coRate = co.opps ? co.matches / co.opps : 0; coN = co.opps;
    } else {
      mean = existing.refSimilarityMean + EW_ALPHA * (best.sim - existing.refSimilarityMean);
      varr = (1 - EW_ALPHA) * (existing.refSimilarityVar + EW_ALPHA * (best.sim - existing.refSimilarityMean) ** 2);
      dev = existing.fieldDeviationMean + EW_ALPHA * (best.dev - existing.fieldDeviationMean);
      rounds = existing.roundsObserved + 1;
      // Only update the co-excursion rate on rounds that presented an opportunity (reference excursioned).
      if (co.opps > 0) {
        const roundRate = co.matches / co.opps;
        coRate = existing.coExcursionRate + EW_ALPHA * (roundRate - existing.coExcursionRate);
        coN = existing.coExcursionN + co.opps;
      } else {
        coRate = existing.coExcursionRate; coN = existing.coExcursionN;
      }
    }
    const confidence = Math.min(1, rounds / 500);
    const probability = confidence * best.prob;
    // Combined probability folds value-similarity and co-excursion. Co-excursion only earns trust after
    // enough joint opportunities (excursions are rare); until then it defers to the value-similarity
    // probability. Chance co-excursion rate is ~0.5 (same sign by luck), so map rate through that.
    const coConfidence = Math.min(1, coN / 40); // ~40 joint excursions to trust the rate
    const coSignal = Math.max(0, (coRate - 0.5) / 0.5); // 0 at chance, 1 at always-same-direction
    // Combine: a provider that is BOTH value-similar and co-excursions is high-confidence. Use a soft OR
    // (noisy-or) so either strong signal lifts it, but co-excursion is gated by its own confidence.
    const combinedProbability =
      1 - (1 - probability) * (1 - coConfidence * coSignal * confidence);
    const data = {
      refSimilarityMean: mean, refSimilarityVar: varr, fieldDeviationMean: dev,
      roundsObserved: rounds, confidence, probability,
      coExcursionRate: coRate, coExcursionN: coN, combinedProbability,
      bestVariant: best.vk, updatedAt: now,
    };
    if (!existing) await prisma.providerSimilarity.create({ data: { network: "flare", voter: addr, ...data } });
    else await prisma.providerSimilarity.update({ where: { id: existing.id }, data });
  }

  // Fold this round's per-variant anchor/field samples into each variant's calibration.
  for (const vk of variantKeys) {
    await updateCalibration(vk, cals.get(vk), anchorByVariant.get(vk), fieldByVariant.get(vk));
  }
}

// Gaussian pdf.
function npdf(x, mean, varr) {
  const v = Math.max(varr, 1e-6);
  return Math.exp(-((x - mean) ** 2) / (2 * v)) / Math.sqrt(2 * Math.PI * v);
}
// Posterior P(example | similarity), equal priors, anchor vs field Gaussians. Falls back to 0 until we
// have enough anchor samples to trust the anchor distribution.
function posteriorExample(sim, cal) {
  if (!cal || cal.anchorN < 20) return 0; // not enough anchor data yet -> no probability asserted
  const la = npdf(sim, cal.anchorMean, cal.anchorVar);
  const lf = npdf(sim, cal.fieldMean, cal.fieldVar);
  const denom = la + lf;
  return denom > 0 ? la / denom : 0;
}
// EW-update a variant's running (mean, var, n) anchor + field accumulators with this round's samples.
async function updateCalibration(variantKey, cal, anchorSamples, fieldSamples) {
  const A = 0.02; // slow EW so the distributions are stable
  let { anchorMean, anchorVar, anchorN, fieldMean, fieldVar, fieldN } = cal;
  for (const s of anchorSamples) {
    const d = s - anchorMean;
    anchorMean += A * d;
    anchorVar = (1 - A) * (anchorVar + A * d * d);
    anchorN++;
  }
  for (const s of fieldSamples) {
    const d = s - fieldMean;
    fieldMean += A * d;
    fieldVar = (1 - A) * (fieldVar + A * d * d);
    fieldN++;
  }
  await prisma.detectionCalibration.upsert({
    where: { id: variantKey },
    create: { id: variantKey, anchorMean, anchorVar, anchorN, fieldMean, fieldVar, fieldN },
    update: { anchorMean, anchorVar, anchorN, fieldMean, fieldVar, fieldN },
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
