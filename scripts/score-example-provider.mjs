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

let rpcId = 0;
async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
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
    const refs = await prisma.referenceSample.findMany({ where: { round } });
    if (refs.length === 0) continue;
    const reveals = await revealsForRound(round, latest);
    if (reveals.size === 0) {
      console.log(`round ${round}: no reveals decoded, skip`);
      continue;
    }
    await scoreRound(round, refs, reveals);
    console.log(`round ${round}: scored ${reveals.size} providers against ${refs.length} ref instances`);
  }
  await prisma.$disconnect();
}

// Scoring for one round. refs: ReferenceSample[] (values keyed by feed NAME). reveals: Map<addr,uint32[]>.
// We need the canonical feed order to map reveal indices -> feed names. It is the same order the
// reference config uses; collect-reference.mjs writes an ordered `values` object, so we read names from
// the first ref sample's key order.
async function scoreRound(round, refs, reveals) {
  const feedNames = Object.keys(refs[0].values); // canonical order (index-aligned with reveals)
  const providers = [...reveals.entries()];
  const nFeeds = Math.min(feedNames.length, ...providers.map(([, v]) => v.length));

  // Per feed: gather provider raw ints, compute median + dispersion (CV) to decide discriminating.
  const OFFSET = 0x80000000; // 2^31, the encoder's zero point
  const perFeed = [];
  for (let f = 0; f < nFeeds; f++) {
    const vals = providers.map(([, v]) => v[f]).filter((x) => Number.isFinite(x) && x > 0);
    if (vals.length < 5) { perFeed.push(null); continue; }
    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
    // The encoded magnitude is (raw - 2^31); dispersion relative to THAT is the real cross-provider
    // disagreement. Feeds where providers agree tightly (liquid) have tiny relative spread and carry no
    // signal; discriminating feeds have meaningful relative spread.
    const magnitude = Math.abs(median - OFFSET) || 1;
    const relSpread = sd / magnitude;
    perFeed.push({ median, sd: sd || 1, magnitude, relSpread, discriminating: relSpread > DISCRIMINATING_CV });
  }

  // Reference raw-int per feed: convert each ref instance's value to the SAME raw space by matching the
  // provider median scale. Since we lack decimals in calldata, we approximate the encoding scale per
  // feed from the provider distribution: raw ~= offset + value*scale. We estimate scale by assuming the
  // provider MEDIAN raw corresponds to the reference MEDIAN value for that feed (robust anchor), then
  // place each ref instance relative to that. This keeps the comparison in raw space without decimals.
  // Map each reference instance's value into the on-chain raw-int space. Both use the same encoding
  // raw = round(value*10^dec) + 2^31; we don't know `dec`, but the provider distribution gives us the
  // scale: the provider median raw corresponds to the reference median value, so
  //   scale = (providerMedian - OFFSET) / refMedianValue,  rawRef = OFFSET + refValue * scale.
  // This anchors ref and providers on the same feed's true price without needing decimals.
  const refByFeed = perFeed.map((pf, f) => {
    if (!pf) return null;
    const name = feedNames[f];
    const refVals = refs.map((r) => r.values[name]).filter((x) => Number.isFinite(x) && x > 0);
    if (refVals.length === 0) return null;
    const refMed = [...refVals].sort((a, b) => a - b)[Math.floor(refVals.length / 2)];
    if (refMed <= 0) return null;
    const scale = (pf.median - OFFSET) / refMed;
    return refVals.map((rv) => OFFSET + rv * scale);
  });

  // For each provider, over DISCRIMINATING feeds only: distance to field median vs distance to nearest
  // reference. Signal = how much closer to reference than the field baseline predicts.
  const now = new Date();
  for (const [addr, v] of providers) {
    let simSum = 0, devSum = 0, cnt = 0;
    for (let f = 0; f < nFeeds; f++) {
      const pf = perFeed[f];
      if (!pf || !pf.discriminating) continue;
      const raw = v[f];
      if (!Number.isFinite(raw)) continue;
      const fieldDist = Math.abs(raw - pf.median) / pf.sd;
      const rr = refByFeed[f];
      if (!rr || rr.length === 0) continue;
      const refDist = Math.min(...rr.map((r) => Math.abs(raw - r))) / pf.sd;
      // Positive when the provider is closer to our reference than to the field median.
      simSum += fieldDist - refDist;
      devSum += fieldDist; // reusable accuracy signal
      cnt++;
    }
    if (cnt === 0) continue;
    const roundSim = simSum / cnt;
    const roundDev = devSum / cnt;

    const existing = await prisma.providerSimilarity.findUnique({
      where: { network_voter: { network: "flare", voter: addr } },
    });
    if (!existing) {
      await prisma.providerSimilarity.create({
        data: {
          network: "flare", voter: addr,
          refSimilarityMean: roundSim, refSimilarityVar: 0,
          fieldDeviationMean: roundDev, roundsObserved: 1,
          probability: 0, confidence: 0, updatedAt: now,
        },
      });
    } else {
      const mean = existing.refSimilarityMean + EW_ALPHA * (roundSim - existing.refSimilarityMean);
      const varr = (1 - EW_ALPHA) * (existing.refSimilarityVar + EW_ALPHA * (roundSim - existing.refSimilarityMean) ** 2);
      const dev = existing.fieldDeviationMean + EW_ALPHA * (roundDev - existing.fieldDeviationMean);
      const rounds = existing.roundsObserved + 1;
      const confidence = Math.min(1, rounds / 500); // full confidence after ~500 rounds (~12h)
      // Calibrated probability: logistic of the standardized similarity, gated by confidence. Calibration
      // constants are placeholder until we fit against the reference-instance floor (Phase 4).
      const z = mean / (Math.sqrt(varr) + 1e-6);
      const probability = confidence * (1 / (1 + Math.exp(-z)));
      await prisma.providerSimilarity.update({
        where: { id: existing.id },
        data: {
          refSimilarityMean: mean, refSimilarityVar: varr, fieldDeviationMean: dev,
          roundsObserved: rounds, confidence, probability, updatedAt: now,
        },
      });
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
