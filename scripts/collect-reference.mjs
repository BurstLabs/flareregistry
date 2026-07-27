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
const INSTANCES = [
  { id: "ref1", url: "http://localhost:3101" },
  { id: "ref2", url: "http://localhost:3102" },
  { id: "ref3", url: "http://localhost:3103" },
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
  // Prune samples older than ~2h (the scorer only looks a few rounds back).
  const cutoff = new Date(Date.now() - 2 * 3600 * 1000);
  const del = await prisma.referenceSample.deleteMany({ where: { createdAt: { lt: cutoff } } });
  if (del.count) console.log(`pruned ${del.count} old reference samples`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
