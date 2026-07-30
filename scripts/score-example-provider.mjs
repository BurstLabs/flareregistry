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
// RPC endpoints tried IN ORDER: our OWN Flare node first (via the reverse SSH tunnel from the dev box,
// exposed on Hetzner at 127.0.0.1:19650) - no rate limits - then the public RPC as automatic fallback if
// the tunnel/node is down, so the pipeline never fully breaks. Override the primary with FLARE_RPC_URL.
const RPC_ENDPOINTS = [
  process.env.FLARE_RPC_URL ?? "http://127.0.0.1:19650/ext/bc/C/rpc",
  "https://flare-api.flare.network/ext/C/rpc",
];
const RPC = RPC_ENDPOINTS[0]; // kept for logs/back-compat; rpc() below tries all endpoints
const SUBMISSION = (process.env.SUBMISSION_ADDR ?? "0x2cA6571Daa15ce734Bbd0Bf27D5C9D16787fc33f").toLowerCase();
const FTSO_PROTOCOL_ID = 100;
const FIRST_VOTING_ROUND_TS = 1658429955;
const VOTING_EPOCH_DURATION = 90;
const REVEAL_SELECTOR = "0x9d00c9fd"; // submit2 (reveal) on Flare
// EW smoothing for the rolling accumulators (~ decays over a few hundred rounds).
const EW_ALPHA = 0.02;
// NO hard feed filter. We use ALL feeds and WEIGHT each by how discriminating it is this round, so a
// liquid feed where everyone agrees contributes ~nothing automatically (its weight -> 0) while a feed
// where the reference genuinely differs from the field contributes proportionally. This removes the
// self-defeating dropout of the old keep/drop gate (agreement among example users collapsed dispersion
// and dropped exactly their feeds) and needs no arbitrary threshold. A feed's weight is how far the
// REFERENCE sits from the field median, in fractional (per-median) terms - i.e. how much signal the feed
// can carry - floored below so numerical noise doesn't create weight, and the distance itself is measured
// in the same fractional units (dimensionless), so feeds combine on a common scale regardless of price.
const WEIGHT_FLOOR_CV = 0.00005; // fractional ref-field gap below which a feed carries ~no signal
// Freshness gate: if the reference's MEDIAN signed offset from the field across all feeds exceeds this,
// the reference is drifted/stale (systematically one-directional) and the round is skipped. Set from the
// observed distribution: routine jitter is ~0.05-0.15% (median 0.07%), genuinely-stale drift is >~0.2%.
// 0.04% over-rejected 2/3 of rounds as "stale" when they were fine; 0.2% catches real staleness only.
const REF_STALE_OFFSET_CV = 0.002;
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

// Canonical feed order (index -> {name, decimals}) for the reward epoch covering a voting round. It is
// the PROTOCOL order the reveal value array uses (NOT the example provider's config order). Cached in the
// DB (canonicalJson + range) so the scorer does not hit GitHub's rate-limited contents API every run -
// it only refetches when the round leaves the cached range. In-process cache on top for one run.
let canonicalMem = null;
async function canonicalFeeds(round) {
  if (canonicalMem && round >= canonicalMem.from && round <= canonicalMem.to) return canonicalMem.feeds;
  // DB cache.
  const cur = await prisma.detectionCursor.findUnique({ where: { id: "flare" } });
  if (cur?.canonicalJson && cur.canonicalFrom != null && cur.canonicalTo != null &&
      round >= cur.canonicalFrom && round <= cur.canonicalTo) {
    canonicalMem = { feeds: cur.canonicalJson, from: cur.canonicalFrom, to: cur.canonicalTo };
    return canonicalMem.feeds;
  }
  // Miss -> fetch from GitHub (rate-limited; only happens ~once per reward epoch now). Pick the epoch
  // whose voting-round range contains `round`; fall back to the newest published epoch (canonicalFeedOrder
  // is stable across adjacent epochs). Throws on total failure so the caller treats it as transient.
  const eps = await candidateEpochs();
  let newest = null, newestRange = null;
  for (const ep of eps) {
    const r = await fetch(`${FSP_BASE}/${ep}/reward-epoch-info.json`, { cache: "no-store" });
    if (!r.ok) { if (r.status === 429 || r.status >= 500) throw new Error(`fsp-rewards HTTP ${r.status}`); continue; }
    const info = await r.json();
    if (!Array.isArray(info.canonicalFeedOrder)) continue;
    const feeds = info.canonicalFeedOrder.map((f) => ({ name: feedIdToName(f.id), decimals: f.decimals ?? 5 }));
    const start = info.expectedStartVotingRoundId ?? info.signingPolicy?.startVotingRoundId ?? 0;
    const end = info.expectedEndVotingRoundId ?? info.endVotingRoundId ?? start + REWARD_EPOCH_DURATION_ROUNDS;
    if (newest == null) { newest = feeds; newestRange = [start, end]; }
    if (round >= start && round <= end) { await cacheCanonical(feeds, start, end); return feeds; }
  }
  // Round is past the latest published epoch: use the newest order but cache it only for rounds at/after
  // its start (open-ended forward), so future in-epoch rounds hit the cache.
  if (newest) { await cacheCanonical(newest, newestRange[0], round + REWARD_EPOCH_DURATION_ROUNDS); return newest; }
  throw new Error("no canonical feed order available");
}
async function cacheCanonical(feeds, from, to) {
  canonicalMem = { feeds, from, to };
  await prisma.detectionCursor.upsert({
    where: { id: "flare" },
    create: { id: "flare", lastRound: 0, canonicalJson: feeds, canonicalFrom: from, canonicalTo: to },
    update: { canonicalJson: feeds, canonicalFrom: from, canonicalTo: to },
  });
}

// Candidate reward-epoch dir numbers to probe for a given voting round: list the fsp-rewards flare dir
// and return numeric epoch names, newest first (bounded).
let epochListCache = null;
async function candidateEpochs() {
  if (epochListCache) return epochListCache;
  try {
    const r = await fetch("https://api.github.com/repos/flare-foundation/fsp-rewards/contents/flare", { cache: "no-store" });
    if (!r.ok) throw new Error(`contents HTTP ${r.status}`); // rate-limited -> transient, don't cache []
    const arr = await r.json();
    epochListCache = arr.filter((x) => /^\d+$/.test(x.name)).map((x) => +x.name).sort((a, b) => b - a).slice(0, 6);
  } catch {
    return []; // do NOT cache the empty result; retry next call
  }
  return epochListCache;
}

let rpcId = 0;
// Single attempt against one endpoint.
async function rpcOnce(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result;
}
// Try each endpoint in order (our own node first, public fallback), each with retry + exponential
// backoff. The reveal decoder makes hundreds of block fetches per round; our own node avoids the public
// RPC's rate limits, and the fallback keeps the pipeline alive if the tunnel/node is briefly down.
// `requireResult`: when true, a null/undefined result is treated as a FAILURE (retry / fall to the next
// endpoint) rather than a valid answer - used for block fetches where a null means "this endpoint doesn't
// have that block right now", NOT "the block doesn't exist". Treating a spurious null as real corrupted
// the block-timestamp binary search (it collapsed to block 1).
async function rpc(method, params, requireResult = false) {
  let lastErr;
  for (const url of RPC_ENDPOINTS) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await rpcOnce(url, method, params);
        if (requireResult && res == null) throw new Error("null result");
        return res;
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 200 * 2 ** attempt));
      }
    }
    // exhausted retries on this endpoint -> fall through to the next
  }
  throw lastErr;
}
// Fetch a block that IS expected to exist (number <= head). Requires a non-null result, so a transient
// null from our node falls back to the public RPC instead of poisoning the binary search.
const getBlock = (numHex, full) => rpc("eth_getBlockByNumber", [numHex, full], true);

// BATCH-fetch a contiguous inclusive block range [from..to] in ONE JSON-RPC request. This is the key
// throughput fix: the reverse tunnel adds ~0.4s round-trip PER request, so ~40 sequential fetches per
// round = ~20s; batching makes it 1 round-trip. Tries our node first, public fallback; every block in
// range exists (<= head) so any null/missing entry fails the whole batch to trigger the fallback.
async function getBlockRange(from, to, full) {
  const reqs = [];
  for (let b = from; b <= to; b++) {
    reqs.push({ jsonrpc: "2.0", id: b, method: "eth_getBlockByNumber", params: [`0x${b.toString(16)}`, full] });
  }
  if (reqs.length === 0) return new Map();
  let lastErr;
  for (const url of RPC_ENDPOINTS) {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reqs),
          signal: AbortSignal.timeout(30000),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const arr = await r.json();
        if (!Array.isArray(arr)) throw new Error("batch: non-array response");
        const byNum = new Map();
        for (const item of arr) {
          if (item.error || item.result == null) throw new Error("batch: missing block");
          byNum.set(parseInt(item.result.number, 16), item.result);
        }
        if (byNum.size !== reqs.length) throw new Error("batch: incomplete");
        return byNum; // Map<blockNumber, block>
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 200 * 2 ** attempt));
      }
    }
  }
  throw lastErr;
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
async function revealsForRound(round, latestBlock, headTs, blockSeconds) {
  // Reveal for round R happens during round R+1 (a 90s window). Estimate the window's block range from
  // block-time, pad generously, and BATCH-fetch it in one request (the tunnel's per-request latency makes
  // per-block fetching too slow). Then filter to the exact timestamp window.
  const revealStartTs = FIRST_VOTING_ROUND_TS + (round + 1) * VOTING_EPOCH_DURATION;
  const revealEndTs = revealStartTs + VOTING_EPOCH_DURATION;
  const centerTs = revealStartTs + VOTING_EPOCH_DURATION / 2;
  const byProvider = new Map();
  // Window is ~VOTING_EPOCH_DURATION/blockSeconds blocks wide; pad by that + margin. Estimate the center
  // block from the head anchor using the MEASURED block time. If the fetched batch doesn't actually cover
  // the timestamp window (block-time drift over a long distance), recentre on a real block and refetch.
  const windowBlocks = Math.ceil(VOTING_EPOCH_DURATION / blockSeconds);
  const pad = windowBlocks + 25;
  let est = latestBlock - Math.round((headTs - centerTs) / blockSeconds);
  let from, to, blocks;
  for (let tries = 0; tries < 3; tries++) {
    from = Math.max(1, est - pad);
    to = Math.min(latestBlock, est + pad);
    blocks = await getBlockRange(from, to, true);
    const firstTs = parseInt(blocks.get(from).timestamp, 16);
    const lastTs = parseInt(blocks.get(to).timestamp, 16);
    if (firstTs <= revealStartTs && lastTs >= revealEndTs) break; // window fully covered
    if (to >= latestBlock && lastTs < revealStartTs) break; // window is past head (too fresh); give up
    // Re-estimate from a real anchor inside this batch (accurate local block time near the target).
    const anchorTs = firstTs > revealStartTs ? firstTs : lastTs;
    const anchorBlk = firstTs > revealStartTs ? from : to;
    est = anchorBlk - Math.round((anchorTs - centerTs) / blockSeconds);
  }
  for (let b = from; b <= to; b++) {
    const blk = blocks.get(b);
    if (!blk) continue;
    const ts = parseInt(blk.timestamp, 16);
    if (ts < revealStartTs || ts > revealEndTs) continue;
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
  const headTs = parseInt((await getBlock(`0x${latest.toString(16)}`, false)).timestamp, 16);
  // Measure the ACTUAL avg block time from a second anchor 20k blocks back (it is ~1.13s, not the 1.8s we
  // assumed - that error placed the estimated block window off by minutes and dropped reveals).
  const anchorBack = Math.max(1, latest - 20000);
  const anchorTs = parseInt((await getBlock(`0x${anchorBack.toString(16)}`, false)).timestamp, 16);
  const blockSeconds = (headTs - anchorTs) / (latest - anchorBack) || 1.13;
  const cur = currentRound();
  // Process every NEW settled round since the cursor, so accumulation tracks wall-clock 1:1 and never
  // double-counts a round or falls behind. Reveal for round R settles DURING R+1, but to be safe against
  // our node being a block behind and the run landing mid-round, we wait until cur-SETTLE_ROUNDS before
  // scoring (and cursor-advancing past) a round - otherwise a too-fresh round decodes "no reveals" and is
  // lost permanently. Bounded below by the cursor and the oldest retained reference sample; capped per run.
  const SETTLE_ROUNDS = 3;
  const cursor = await prisma.detectionCursor.findUnique({ where: { id: "flare" } });
  const lastScored = cursor?.lastRound ?? 0;
  const oldestSample = await prisma.referenceSample.aggregate({ _min: { round: true } });
  const floor = Math.max(lastScored, (oldestSample._min.round ?? 1) - 1);
  const sampled = await prisma.referenceSample.groupBy({
    by: ["round"],
    where: { round: { lte: cur - SETTLE_ROUNDS, gt: floor } },
    orderBy: { round: "asc" },
    take: 200, // safety cap per run
  });
  const rounds = sampled.map((s) => s.round); // already ascending
  if (rounds.length === 0) {
    console.log(`no new settled rounds (cur=${cur}, lastScored=${lastScored})`);
    await prisma.$disconnect();
    return;
  }
  // Contiguity anchor: one below the first round we're processing (the cursor may sit far below the
  // actual round numbers, e.g. 0 on first run, so we can't compare against lastScored directly).
  let maxDone = rounds[0] - 1;

  // Advance the cursor only through rounds we've DEFINITIVELY handled in ascending order. A transient
  // failure (RPC error, missing canonical order) stops the advance so that round is retried next run; a
  // real decision (scored, stale-skip, or no-reveals) advances past it. This guarantees no round is
  // permanently lost to a transient hiccup AND none is double-counted.
  for (const round of rounds) {
    try {
      const refs = await prisma.referenceSample.findMany({ where: { round } });
      if (refs.length === 0) { if (round === maxDone + 1) maxDone = round; continue; }
      const canonical = await canonicalFeeds(round); // throws on transient fetch failure -> caught below
      const reveals = await revealsForRound(round, latest, headTs, blockSeconds);
      if (reveals.size === 0) {
        // No reveals could mean the round is still too fresh (reveals not on our node yet) OR a decode
        // problem. Don't advance past a RECENT round - retry it next run once it's had more time. Only
        // give up (advance) on an OLD round where reveals will never appear (stale data / genuine gap).
        const old = round <= cur - 8;
        console.log(`round ${round}: no reveals decoded${old ? " (old, skipping)" : " (recent, will retry)"}`);
        if (old && round === maxDone + 1) maxDone = round;
        if (!old) break; // stop advancing; retry from here next run
        continue;
      }
      const res = await scoreRound(round, refs, reveals, canonical);
      if (!res?.skipped) {
        console.log(`round ${round}: scored ${reveals.size} providers against ${refs.length} ref instances`);
      }
      if (round === maxDone + 1) maxDone = round; // handled (scored or stale-skip) -> advance
    } catch (e) {
      console.error(`round ${round}: transient failure, will retry - ${e.message}`);
      break; // stop advancing; retry from here next run
    }
  }
  if (maxDone > lastScored) {
    await prisma.detectionCursor.upsert({
      where: { id: "flare" },
      create: { id: "flare", lastRound: maxDone },
      update: { lastRound: maxDone },
    });
  }
  await prisma.$disconnect();
}

const OFFSET = 0x80000000; // 2^31, the encoder's zero point
const decodeValue = (raw, decimals) => (raw - OFFSET) / 10 ** decimals; // raw uint32 -> real price

// Median of a numeric array (averages the two central values for even length). Non-mutating.
function median(arr) {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Scoring for one round. reveals index i corresponds to canonical[i] = {name, decimals}. We decode each
// provider's raw ints to REAL values via decimals, then compare (per feed, in real-value space) each
// provider to our reference instances vs the field median. Signal lives on DISCRIMINATING feeds (where
// providers actually disagree); liquid feeds where everyone converges carry none.
// Variant of a reference instance id "variant:n" -> "variant".
const variantOf = (instanceId) => String(instanceId).split(":")[0];

// How many times a CONFIRMED-CUSTOM provider's similarity counts toward the field/negative distribution
// (vs 1 for an anonymous field sample). NOTE: under EW with A=0.02 and ~94 field samples/round, a couple
// of known customs at this weight only nudge the field distribution slightly - the PRIMARY correction
// that makes known-customs read ~0% is the baseline rescale in the API layer. This weighting is a
// secondary nudge that sharpens the field mean toward verified negatives over many rounds.
const KNOWN_CUSTOM_WEIGHT = 8;

async function scoreRound(round, refs, reveals, canonical) {
  const providers = [...reveals.entries()];
  // Use the full canonical feed count. A provider whose reveal array is SHORT is handled per-provider
  // (decodeValue returns NaN past its length, which is filtered), so one short reveal no longer collapses
  // the feed set for EVERYONE (the old min-across-providers did exactly that).
  const nFeeds = canonical.length;

  // Verified-custom set (trusted negatives): their similarity is fed into the field distribution with
  // extra weight, sharpening the anchor-vs-field boundary against providers we KNOW aren't the example.
  const knownCustomRows = await prisma.detectionLabel.findMany({ where: { knownCustom: true } });
  const knownCustom = new Set(knownCustomRows.map((r) => r.address.toLowerCase()));

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
    const med = median(vals);
    // MAD (median absolute deviation), scaled; the robust spread for excursion flagging.
    const mad = (median(vals.map((x) => Math.abs(x - med))) || med * 1e-9) * 1.4826;
    // Reference position on this feed (median across all instances) and its fractional gap from the field
    // median. That gap IS the feed's discriminating power: if the reference sits on the field, the feed
    // can't distinguish anyone (weight ~0); the further the reference is, the more a provider's position
    // relative to it tells us. No keep/drop - every feed participates, weighted by this.
    const rv = refs.map((r) => r.values[name]).filter((x) => Number.isFinite(x) && x > 0);
    const refMed = rv.length ? median(rv) : null;
    const refFieldGapCv = refMed != null && med > 0 ? Math.abs(refMed - med) / med : 0;
    // SIGNED fractional offset of the reference from the field (for the staleness gate below).
    const refSignedCv = refMed != null && med > 0 ? (refMed - med) / med : null;
    const weight = Math.max(0, refFieldGapCv - WEIGHT_FLOOR_CV);
    perFeed.push({ name, median: med, mad, refMed, refFieldGapCv, refSignedCv, weight });
  }

  // FRESHNESS GATE - never score against a STALE reference. A healthy reference's per-feed offsets from
  // the live field (= the on-chain consensus, our ground truth) scatter around zero; a stale reference
  // (drifted CCXT buffers) sits SYSTEMATICALLY on one side of the field on nearly every feed. Detect that
  // as a large-magnitude MEDIAN signed offset across feeds, and if so, SKIP the round entirely rather than
  // record biased scores. This makes staleness impossible to poison a score, independent of restart timing.
  const signedOffsets = perFeed.filter((p) => p && p.refSignedCv != null).map((p) => p.refSignedCv);
  const medianOffset = signedOffsets.length ? median(signedOffsets) : 0;
  if (Math.abs(medianOffset) > REF_STALE_OFFSET_CV) {
    console.log(
      `round ${round}: SKIP - reference looks stale (median offset ${(medianOffset * 100).toFixed(3)}% ` +
      `across ${signedOffsets.length} feeds, threshold ${(REF_STALE_OFFSET_CV * 100).toFixed(3)}%)`
    );
    return { skipped: "stale-reference", medianOffset };
  }

  // Excursion of a single value on feed f: {sign:-1|0|1, mag} where mag is deviation in MADs. sign 0 =
  // within band (not an excursion). Only discriminating feeds carry signal.
  function excursion(f, val) {
    const pf = perFeed[f];
    if (!pf || pf.weight <= 0 || !Number.isFinite(val) || val <= 0) return { sign: 0, mag: 0 };
    const z = (val - pf.median) / Math.max(pf.mad, pf.median * 1e-6);
    if (Math.abs(z) < EXCURSION_K) return { sign: 0, mag: Math.abs(z) };
    return { sign: Math.sign(z), mag: Math.abs(z) };
  }

  // Similarity of a target against a per-feed reference-value set, over ALL feeds, WEIGHTED by each
  // feed's discriminating power (perFeed[f].weight = fractional ref-field gap). `getVal(f)` -> target's
  // real value; `refSet(f)` -> array of reference values for that feed (variant-specific).
  //
  // Per feed we ask: is the target closer to the reference or to the field, in FRACTIONAL terms
  // (dimensionless, so all feeds combine on one scale)? Contribution = (fieldDist - refDist)/gap, which
  // is +1 when the target sits exactly on the reference, -1 when it sits on the field, and interpolates
  // between - then averaged with the feed weights. Liquid feeds have weight ~0 and drop out on their own.
  function similarityOf(getVal, refSet) {
    let simW = 0, devW = 0, wSum = 0;
    for (let f = 0; f < nFeeds; f++) {
      const pf = perFeed[f];
      if (!pf || pf.weight <= 0 || pf.median <= 0) continue;
      const val = getVal(f);
      if (!Number.isFinite(val) || val <= 0) continue;
      const rr = refSet(f);
      if (!rr || rr.length === 0) continue;
      const refMed = median(rr);
      const gap = Math.abs(refMed - pf.median) / pf.median; // fractional ref-field gap for THIS ref set
      if (gap <= 0) continue;
      const fieldDist = Math.abs(val - pf.median) / pf.median;
      const refDist = Math.abs(val - refMed) / pf.median;
      // (fieldDist - refDist)/gap in [-1, 1]: +1 on the reference, -1 on the field. Clamp for outliers.
      const s = Math.max(-1, Math.min(1, (fieldDist - refDist) / gap));
      simW += pf.weight * s;
      devW += pf.weight * fieldDist; // weighted accuracy proxy (distance from field consensus)
      wSum += pf.weight;
    }
    return { sim: wSum ? simW / wSum : null, dev: wSum ? devW / wSum : null, cnt: wSum ? 1 : 0 };
  }

  const now = new Date();
  // Load all variants' calibration state up front.
  const variantKeys = [...byVariant.keys()];
  const cals = new Map();
  for (const vk of variantKeys) {
    cals.set(
      vk,
      (await prisma.detectionCalibration.findUnique({ where: { id: vk } })) ??
        { anchorMean: 0, anchorVar: 0, anchorN: 0, fieldMean: 0, fieldVar: 0, fieldN: 0 }
    );
  }

  // Per-variant reference value sets + this round's ANCHOR (positive-class) samples.
  //
  // The anchor defines what an example-provider user is SUPPOSED to look like. It used to be built by
  // scoring each instance against its own same-config twins - but those twins were measured to be
  // BYTE-IDENTICAL (same box, network and restart tick), so the anchor encoded "a perfect clone of
  // myself". No real provider on their own infrastructure can ever reach that, so every provider was
  // forced into the field/custom class: a direct cause of 100% false negatives.
  //
  // The anchor is now CROSS-CONFIG: for variant v, the positive class is every OTHER-config reference
  // instance scored against v. That is exactly the realistic bar - "a genuine example-provider user whose
  // exchange config differs from ours" - which is attainable, so a real user can actually clear it.
  const anchorByVariant = new Map(); // vk -> number[]
  const fieldByVariant = new Map(); // vk -> number[]
  const refSetByVariant = new Map(); // vk -> (f)=>values[]
  for (const vk of variantKeys) {
    const vinsts = byVariant.get(vk);
    refSetByVariant.set(vk, (f) =>
      vinsts.map((r) => r.values[perFeed[f]?.name]).filter((x) => Number.isFinite(x) && x > 0)
    );
    fieldByVariant.set(vk, []);
  }
  for (const vk of variantKeys) {
    const anchor = [];
    for (const other of refs) {
      if (variantOf(other.instance) === vk) continue; // same config = near-identical twin, not a fair bar
      const s = similarityOf((f) => other.values[perFeed[f]?.name], refSetByVariant.get(vk));
      if (s.sim != null) anchor.push(s.sim);
    }
    anchorByVariant.set(vk, anchor);
  }

  // --- REFERENCE EXCURSION SIGNATURE for this round ---
  // For each discriminating feed, does OUR reference example provider excursion from the network median,
  // and which direction? Use the reference median value across ALL instances (variants included) as the
  // reference position on that feed. refExcursion[f] = sign in {-1,0,1}; sign 0 = no reference excursion.
  const refExcursion = new Array(nFeeds).fill(0);
  const refExcursionFeeds = [];
  for (let f = 0; f < nFeeds; f++) {
    const pf = perFeed[f];
    if (!pf || pf.weight <= 0) continue;
    const rv = refs.map((r) => r.values[pf.name]).filter((x) => Number.isFinite(x) && x > 0);
    if (rv.length === 0) continue;
    const refMed = median(rv);
    const e = excursion(f, refMed);
    if (e.sign !== 0) { refExcursion[f] = e.sign; refExcursionFeeds.push(f); }
  }

  // Per reference-excursion feed, the FIELD baseline: fraction of all providers that excursioned the SAME
  // direction as the reference. When the reference spikes because the TRUE price genuinely moved, most of
  // the field co-moves too, so this baseline is high - the "chance" same-direction rate is NOT 0.5. A
  // provider only carries signal when it matches MORE often than the field baseline predicts.
  const fieldMatchRate = new Map(); // feed -> baseline same-direction fraction
  for (const f of refExcursionFeeds) {
    let m = 0, n = 0;
    for (const [, v] of providers) {
      const e = excursion(f, decodeValue(v[f], canonical[f].decimals));
      if (e.sign !== 0) { n++; if (e.sign === refExcursion[f]) m++; }
    }
    fieldMatchRate.set(f, n ? m / n : 0.5);
  }

  // ERROR-PROFILE vector: ln(|deviation from field median|) per feed. WHICH feeds a target is unusually
  // good or bad on is set by its exchange list and aggregation, so this vector fingerprints the
  // implementation. It is compared later (in the API) only AFTER subtracting each feed's difficulty
  // baseline - illiquid feeds are hard for everyone, and that shared component otherwise dominates the
  // correlation (measured: it put verified-custom Burst FTSO at rank 7; de-meaning drops it to rank 37).
  function feedLogDevs(getVal) {
    const out = {};
    for (let f = 0; f < nFeeds; f++) {
      const pf = perFeed[f];
      if (!pf || !(pf.median > 0)) continue;
      const val = getVal(f);
      if (!Number.isFinite(val) || val <= 0) continue;
      out[pf.name] = Math.log(Math.abs(val - pf.median) / pf.median + 1e-9);
    }
    return out;
  }
  // EW-merge a fresh per-feed vector into an accumulated one.
  function mergeLogDevs(prev, fresh) {
    const out = { ...(prev || {}) };
    for (const [k, v] of Object.entries(fresh)) {
      out[k] = Object.prototype.hasOwnProperty.call(out, k) ? out[k] + EW_ALPHA * (v - out[k]) : v;
    }
    return out;
  }

  // Co-excursion of a target: over feeds where the reference excursioned, its EXCESS same-direction rate
  // above the field baseline. Returns {excess, opps}: excess in [-1,1], averaged over opportunities.
  function coExcursionOf(getVal) {
    let excessSum = 0, opps = 0;
    for (const f of refExcursionFeeds) {
      const e = excursion(f, getVal(f));
      const matched = e.sign === refExcursion[f] ? 1 : 0;
      excessSum += matched - fieldMatchRate.get(f); // how much more than the field baseline
      opps++;
    }
    return { excess: opps ? excessSum / opps : 0, opps };
  }

  // Score each provider against every variant. Select the best variant by RAW SIMILARITY (closest fit),
  // NOT by posterior: the posterior is variance-sensitive, and a narrower-exchange variant has a tighter
  // anchor, so max-posterior would make that variant a catch-all that absorbs almost everyone regardless
  // of genuine fit. Pick the variant the provider's values actually sit closest to, THEN compute the
  // probability from that variant's calibration.
  for (const [addr, v] of providers) {
    const isKnownCustom = knownCustom.has(addr.toLowerCase());
    let best = null;
    for (const vk of variantKeys) {
      const s = similarityOf(
        (f) => decodeValue(v[f], canonical[f].decimals),
        refSetByVariant.get(vk)
      );
      if (s.cnt === 0 || s.sim == null) continue;
      // Field/negative distribution: a confirmed-custom provider is a TRUSTED negative, weighted heavier.
      const weight = isKnownCustom ? KNOWN_CUSTOM_WEIGHT : 1;
      for (let w = 0; w < weight; w++) fieldByVariant.get(vk).push(s.sim);
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
    // coExcursionRate now stores the EW mean EXCESS same-direction rate above the field baseline
    // (centered at 0; positive = co-moves with the reference MORE than the field does).
    let mean, varr, dev, rounds, coRate, coN;
    if (!existing) {
      mean = best.sim; varr = 0; dev = best.dev; rounds = 1;
      coRate = co.opps ? co.excess : 0; coN = co.opps;
    } else {
      mean = existing.refSimilarityMean + EW_ALPHA * (best.sim - existing.refSimilarityMean);
      varr = (1 - EW_ALPHA) * (existing.refSimilarityVar + EW_ALPHA * (best.sim - existing.refSimilarityMean) ** 2);
      dev = existing.fieldDeviationMean + EW_ALPHA * (best.dev - existing.fieldDeviationMean);
      rounds = existing.roundsObserved + 1;
      // Only update on rounds that presented an opportunity (reference excursioned somewhere).
      if (co.opps > 0) {
        coRate = existing.coExcursionRate + EW_ALPHA * (co.excess - existing.coExcursionRate);
        coN = existing.coExcursionN + co.opps;
      } else {
        coRate = existing.coExcursionRate; coN = existing.coExcursionN;
      }
    }
    const confidence = Math.min(1, rounds / 500);
    const probability = confidence * best.prob;
    // Probability is the VALUE-SIMILARITY signal only. Co-excursion (co-spike) is still measured and
    // stored for display context, but no longer folded into P: its null-rate assumptions made it noisy,
    // so P now reflects value similarity alone.
    const combinedProbability = probability;
    // Error-profile accumulation (the implementation fingerprint; correlated against the reference in the API).
    const feedErrors = mergeLogDevs(
      existing?.feedErrorsJson,
      feedLogDevs((f) => decodeValue(v[f], canonical[f].decimals))
    );
    const data = {
      refSimilarityMean: mean, refSimilarityVar: varr, fieldDeviationMean: dev,
      roundsObserved: rounds, confidence, probability,
      coExcursionRate: coRate, coExcursionN: coN, combinedProbability,
      feedErrorsJson: feedErrors, errorProfileN: (existing?.errorProfileN ?? 0) + 1,
      bestVariant: best.vk, updatedAt: now,
    };
    if (!existing) await prisma.providerSimilarity.create({ data: { network: "flare", voter: addr, ...data } });
    else await prisma.providerSimilarity.update({ where: { id: existing.id }, data });
  }

  // Fold this round's per-variant anchor/field samples into each variant's calibration.
  for (const vk of variantKeys) {
    await updateCalibration(vk, cals.get(vk), anchorByVariant.get(vk), fieldByVariant.get(vk));
  }

  // Accumulate OUR REFERENCE's error profile the same way, so the API can de-mean both by feed difficulty
  // and correlate them. perFeed[f].refMed is the reference median for that feed this round.
  const curRow = await prisma.detectionCursor.findUnique({ where: { id: "flare" } });
  const refErrors = mergeLogDevs(
    curRow?.refFeedErrorsJson,
    feedLogDevs((f) => perFeed[f]?.refMed ?? NaN)
  );
  await prisma.detectionCursor.upsert({
    where: { id: "flare" },
    create: { id: "flare", lastRound: 0, refFeedErrorsJson: refErrors },
    update: { refFeedErrorsJson: refErrors },
  });
}

// Require at least this many samples in EACH distribution before asserting any probability.
const CAL_MIN_N = 40;
// Probability that a provider's similarity belongs to the example-provider (anchor) class rather than the
// field. We deliberately do NOT use a raw Gaussian likelihood ratio: with a WIDE anchor and NARROW field
// (which is what the data actually shows - anchor SD ~0.8, field SD ~0.18) the ratio is NON-MONOTONIC and
// RISES AGAIN in the far-below-field tail, so a provider that diverges MOST from the example would wrongly
// score high (observed: verified-custom 1FTSO topping the list). Instead use a MONOTONIC logistic on where
// `sim` sits between the field mean (~0) and the anchor mean (~1). Monotonic in sim by construction:
// more-similar always => higher probability, and a low-similarity provider always reads low.
// Logistic steepness in units of "full swings across the anchor-field gap". Higher = MORE SENSITIVE:
// small similarity differences produce larger P differences, spreading the pack instead of compressing
// most providers near 0. Bumped from 6 -> 11 on request for a more sensitive P.
const POSTERIOR_STEEPNESS = 11;
function posteriorExample(sim, cal) {
  if (!cal) return 0;
  if (cal.anchorN < CAL_MIN_N || cal.fieldN < CAL_MIN_N) return 0;
  const gap = cal.anchorMean - cal.fieldMean;
  if (!(gap > 1e-6)) return 0; // classes not separated (anchor must sit above field)
  const mid = (cal.anchorMean + cal.fieldMean) / 2; // 50% decision point
  const k = POSTERIOR_STEEPNESS / gap;
  return 1 / (1 + Math.exp(-k * (sim - mid)));
}
// EW-update a variant's running (mean, var, n) anchor + field accumulators with this round's samples.
// Lazily SEED each distribution from its first sample (mean=first value, var stays near 0 and grows from
// real spread) instead of EW-nudging from the arbitrary 0.01 seed, which otherwise lingers ~30 rounds and
// distorts the Gaussian likelihoods. `n` starting at 0 marks "unseeded".
async function updateCalibration(variantKey, cal, anchorSamples, fieldSamples) {
  const A = 0.02; // slow EW so the distributions are stable
  let { anchorMean, anchorVar, anchorN, fieldMean, fieldVar, fieldN } = cal;
  const fold = (samples, mean, varr, n) => {
    for (const s of samples) {
      if (n === 0) { mean = s; varr = 0; n = 1; continue; } // seed from first real sample
      const d = s - mean;
      mean += A * d;
      varr = (1 - A) * (varr + A * d * d);
      n++;
    }
    return [mean, varr, n];
  };
  [anchorMean, anchorVar, anchorN] = fold(anchorSamples, anchorMean, anchorVar, anchorN);
  [fieldMean, fieldVar, fieldN] = fold(fieldSamples, fieldMean, fieldVar, fieldN);
  await prisma.detectionCalibration.upsert({
    where: { id: variantKey },
    create: { id: variantKey, anchorMean, anchorVar, anchorN, fieldMean, fieldVar, fieldN },
    update: { anchorMean, anchorVar, anchorN, fieldMean, fieldVar, fieldN },
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
