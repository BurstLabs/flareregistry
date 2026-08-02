// PAIRWISE BYTE-EXACT SUBMISSION AGREEMENT between providers.
//
// This measures the one thing FIP.02's collusion clause actually asks about: whether providers show
// "a strong statistical correlation in their submissions". It is a DIRECT measurement of on-chain
// reveals. It involves no inference about which software anyone runs, no reference instance, no
// calibration and no threshold, which makes it a categorically stronger claim than anything in the
// example-provider detection: that work infers a cause, this counts an effect.
//
// For every pair of providers we count the (round, feed) cells where both revealed a usable value and
// the encoded uint32 is IDENTICAL. Identical to the last digit, not close. Two independent
// implementations reading different venues essentially never agree to the last digit on a volatile
// feed, so the field-wide rate is the natural null and it is reported alongside.
//
//   node scripts/measure-submission-agreement.mjs [rounds] [classFile]
//
// classFile is the /api/detection payload, used ONLY to label the output. The measurement itself is
// classification-blind: every pair is computed the same way.
import { canonicalFeeds, revealsForRound, currentRound, rpc } from "./score-example-provider.mjs";
import fs from "node:fs";

const N_ROUNDS = Number(process.argv[2] ?? 120);
const CLASS_FILE = process.argv[3] ?? "/tmp/det.json";
const OFFSET = 0x80000000;

function pct(x) {
  return (x * 100).toFixed(2) + "%";
}

// Mean over pairs, plus the quartiles, because a mean alone hides whether a block is uniform or has
// a tight core with stragglers.
function summarise(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return {
    n: s.length,
    mean: s.reduce((a, b) => a + b, 0) / s.length,
    p25: q(0.25),
    median: q(0.5),
    p75: q(0.75),
    max: s[s.length - 1],
  };
}

async function main() {
  const klass = new Map();
  try {
    const det = JSON.parse(fs.readFileSync(CLASS_FILE, "utf8"));
    for (const p of det.providers ?? []) klass.set(p.submitAddress.toLowerCase(), p.class);
  } catch {
    console.error(`(no classification at ${CLASS_FILE}; reporting field-wide only)`);
  }

  const latest = parseInt(await rpc("eth_blockNumber", []), 16);
  const head = await rpc("eth_getBlockByNumber", ["0x" + latest.toString(16), false], true);
  const headTs = parseInt(head.timestamp, 16);
  const probe = await rpc("eth_getBlockByNumber", ["0x" + (latest - 1000).toString(16), false], true);
  const blockSeconds = (headTs - parseInt(probe.timestamp, 16)) / 1000;

  // Reveal for round R lands in R+1, so the newest fully revealed round is two behind the current one.
  const end = currentRound() - 2;
  const start = end - N_ROUNDS + 1;
  console.error(`rounds ${start}..${end} (${N_ROUNDS}), block time ${blockSeconds.toFixed(3)}s`);

  // pairKey -> [agreeing cells, comparable cells]
  const pairs = new Map();
  const seen = new Set();
  let usedRounds = 0;

  for (let round = start; round <= end; round++) {
    let reveals, canonical;
    try {
      canonical = await canonicalFeeds(round);
      reveals = await revealsForRound(round, latest, headTs, blockSeconds);
    } catch (e) {
      console.error(`  round ${round}: ${e.message}`);
      continue;
    }
    if (reveals.size < 2) continue;
    usedRounds++;

    const addrs = [...reveals.keys()].sort();
    for (const a of addrs) seen.add(a);
    for (let i = 0; i < addrs.length; i++) {
      const va = reveals.get(addrs[i]);
      for (let j = i + 1; j < addrs.length; j++) {
        const vb = reveals.get(addrs[j]);
        const len = Math.min(va.length, vb.length, canonical.length);
        let agree = 0, total = 0;
        for (let f = 0; f < len; f++) {
          // Skip the unpriced-feed sentinel on either side: raw == 2^31 decodes to a price of zero and
          // two providers both declining to price a feed is not agreement about anything.
          if (!(va[f] - OFFSET > 0) || !(vb[f] - OFFSET > 0)) continue;
          total++;
          if (va[f] === vb[f]) agree++;
        }
        if (!total) continue;
        const key = addrs[i] + "|" + addrs[j];
        const cur = pairs.get(key);
        if (cur) { cur[0] += agree; cur[1] += total; }
        else pairs.set(key, [agree, total]);
      }
    }
    if (usedRounds % 20 === 0) console.error(`  ${usedRounds} rounds, ${pairs.size} pairs`);
  }

  console.log(`\nrounds used: ${usedRounds}   providers seen: ${seen.size}   pairs: ${pairs.size}\n`);

  // Bucket every pair by the classes of its two members. MIN_CELLS drops pairs with too little overlap
  // to mean anything (a provider that joined mid-window, or one that prices few feeds).
  const MIN_CELLS = 2000;
  const buckets = new Map();
  for (const [key, [agree, total]] of pairs) {
    if (total < MIN_CELLS) continue;
    const [a, b] = key.split("|");
    const ka = klass.get(a) ?? "unknown";
    const kb = klass.get(b) ?? "unknown";
    const label = [ka, kb].sort().join(" x ");
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(agree / total);
  }

  const rows = [...buckets.entries()]
    .map(([label, vals]) => [label, summarise(vals)])
    .sort((x, y) => y[1].mean - x[1].mean);

  console.log("pairwise byte-exact agreement, by class pairing");
  console.log("  " + "pairing".padEnd(30) + "pairs   mean     p25      median   p75      max");
  for (const [label, s] of rows) {
    console.log(
      "  " + label.padEnd(30) + String(s.n).padStart(5) + "  " +
      [s.mean, s.p25, s.median, s.p75, s.max].map((x) => pct(x).padStart(8)).join(" ")
    );
  }

  // The headline: candidate-to-candidate against the rest of the field.
  const cc = buckets.get("candidate x candidate");
  const ee = buckets.get("excluded x excluded");
  const ce = buckets.get("candidate x excluded");
  if (cc && ee) {
    const m = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    console.log(
      `\ncandidate-to-candidate mean ${pct(m(cc))} against excluded-to-excluded ${pct(m(ee))}` +
      (ce ? ` and cross-class ${pct(m(ce))}` : "")
    );
    console.log(`ratio to the excluded baseline: ${(m(cc) / m(ee)).toFixed(1)}x`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
