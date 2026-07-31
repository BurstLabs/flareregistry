// Reference-value collector (FLARE ONLY). Runs ON the Hetzner box where the ftso-ref instances live.
// Each voting round it polls both example-provider instances for the FULL Flare feed set (in canonical
// config order, so indices align with on-chain reveals) and writes one ReferenceSample row per
// instance. Old samples are pruned (the scorer only needs the last few rounds).
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";

const prisma = new PrismaClient();
const FIRST_VOTING_ROUND_TS = 1658429955;
const VOTING_EPOCH_DURATION = 90;
// Both local reference instances.
// Reference fleet: multiple exchange-subset VARIANTS, 2 instances each. Providers who run the example
// code typically edit feeds.json to keep only the top-N exchanges, so each variant is a distinct
// fingerprint. `instance` is stored as "<variant>:<n>"; the scorer groups by variant and takes the
// best-matching one per provider. Two instances per variant give the non-determinism floor for that
// variant's anchor.
// Each variant is a DISTINCT exchange subset. We previously ran 2 instances per variant, but measured
// them to be byte-identical (same box, same network, same restart tick), so the duplicates carried zero
// information AND made the calibration "anchor" mean "a perfect clone of myself" - an impossible standard
// no real provider could meet, which forced every provider into the custom class. Now: one instance per
// config, spanning the space real providers actually use. The full:2 A/B control (does the 30-minute
// restart cycle degrade fidelity?) has been retired now that the question is settled, freeing ~900MB for
// a historical checkout, which answers a live question instead.
const INSTANCES = [
  { id: "full:1", url: "http://localhost:3101" },
  // HISTORICAL checkouts of the example provider. Same algorithm (MEDIAN_DECAY has never changed across
  // all 134 commits), but a different VENUE LIST, which is what actually moves the tick-grid signature.
  // hist2512 = commit 18278fb9, 2025-12-31: carries `probit` and has no `coinex`, the reverse of HEAD.
  // These are matched as bestConfig candidates so a provider can be pinned to a code ERA, but they are
  // excluded from the pattern normaliser so they cannot move the live 1.0 boundary.
  { id: "hist2512:1", url: "http://localhost:3131" },
  { id: "top3:1", url: "http://localhost:3111" },
  { id: "top5:1", url: "http://localhost:3112" },
  { id: "top8:1", url: "http://localhost:3121" },
  { id: "top12:1", url: "http://localhost:3122" },
];
// Canonical feed order from the example provider's own config (index-aligned with on-chain reveals).
const FEEDS_CONFIG = process.env.FEEDS_CONFIG ?? "/home/deploy/ftso-ref/src/config/feeds.json";
const feeds = JSON.parse(readFileSync(FEEDS_CONFIG, "utf8")).map((f) => f.feed);

function currentRound() {
  return Math.floor((Math.floor(Date.now() / 1000) - FIRST_VOTING_ROUND_TS) / VOTING_EPOCH_DURATION);
}

async function sample(instance, round) {
  const r = await fetch(`${instance.url}/feed-values/${round}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feeds }),
  });
  if (!r.ok) throw new Error(`${instance.id} HTTP ${r.status}`);
  const body = await r.json();
  // Preserve canonical order: build an ordered object feedName -> value.
  const values = {};
  for (const feed of feeds) {
    const hit = body.data.find((d) => d.feed.name === feed.name);
    if (hit && Number.isFinite(hit.value)) values[feed.name] = hit.value;
  }
  return values;
}

async function main() {
  const round = currentRound();
  for (const instance of INSTANCES) {
    try {
      const values = await sample(instance, round);
      await prisma.referenceSample.upsert({
        where: { round_instance: { round, instance: instance.id } },
        create: { round, instance: instance.id, values },
        update: { values },
      });
      console.log(`round ${round} ${instance.id}: ${Object.keys(values).length} feeds`);
    } catch (e) {
      console.error(`round ${round} ${instance.id}: ${e.message}`);
    }
  }
  // Prune samples older than ~6h. The scorer advances via a cursor and normally stays within a few
  // rounds of live, but a wider retention window means a temporary scorer outage (or catch-up after one)
  // still has the reference samples it needs rather than losing those rounds permanently.
  const cutoff = new Date(Date.now() - 6 * 3600 * 1000);
  const del = await prisma.referenceSample.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (del.count) console.log(`pruned ${del.count} old reference samples`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
