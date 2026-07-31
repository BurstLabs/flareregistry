// Official provider SUCCESS RATES from Flare's own systems-explorer entity API.
//
// Flare publishes, per entity, a `providersuccessrate` object with primary and secondary reward-band
// participation plus availability, in BASIS POINTS out of 10000. These are the authoritative numbers
// operators are judged on, so we store them verbatim rather than re-deriving anything: a re-derivation
// would be our opinion of Flare's metric, and would drift from what a provider sees on Flare's own site.
//
// Joined on identity_address, which is ProviderOnchain.voter.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const EXPLORER = {
  flare: "https://flare-systems-explorer.flare.network/backend-url/api/v0",
  songbird: "https://songbird-systems-explorer.flare.network/backend-url/api/v0",
};
const PAGE = 100;

// The API's own `next` link points at an internal cluster hostname
// (flr-systems-explorer-backend-app.flare.svc.cluster.local) which is unreachable from outside, so
// paginate by constructing limit/offset against the PUBLIC host instead of following `next`.
async function fetchAll(base) {
  const out = [];
  let epoch = null;
  for (let offset = 0; ; offset += PAGE) {
    const url = `${base}/entity?limit=${PAGE}&offset=${offset}`;
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
    const body = await r.json();
    const results = body?.results ?? [];
    if (epoch == null && body?.epoch != null) epoch = body.epoch;
    out.push(...results);
    if (out.length >= (body?.count ?? 0) || results.length === 0) break;
    if (offset > 5000) break; // hard stop; the entity set is ~200, never thousands
  }
  return { entities: out, epoch };
}

// The explorer returns weights as JSON NUMBERS beyond Number.MAX_SAFE_INTEGER, so JSON.parse already
// lost the low digits and String() would give scientific notation ("4.07e+25") that BigInt cannot read.
// Convert back to an exact integer string. The float's ~15 significant digits are far more than the ~11
// whole-token display needs, so nothing meaningful is lost - but the STORED form must be parseable.
function weiString(v) {
  if (v == null) return null;
  if (typeof v === "string") return /^\d+$/.test(v) ? v : null;
  if (typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)) {
    try { return BigInt(v).toString(); } catch { return null; }
  }
  return null;
}

async function ingest(network) {
  const base = EXPLORER[network];
  if (!base) return;
  let entities, epoch;
  try {
    ({ entities, epoch } = await fetchAll(base));
  } catch (e) {
    console.error(`${network}: fetch failed - ${e.message}`);
    return;
  }

  const now = new Date();
  let updated = 0, missing = 0, noRate = 0;
  for (const e of entities) {
    const voter = String(e.identity_address ?? "").toLowerCase();
    if (!voter) continue;
    const sr = e.providersuccessrate;
    const sp = e.denormalizedsigningpolicy ?? {};
    if (!sr) { noRate++; continue; }

    // Only update rows we already know about. This job reports Flare's view of an entity; it must not
    // invent ProviderOnchain rows, because that table's identity/role addresses come from the
    // fsp-rewards ingest and are what the whole 5-role join depends on.
    const existing = await prisma.providerOnchain.findUnique({
      where: { network_voter: { network, voter } },
    });
    if (!existing) { missing++; continue; }

    await prisma.providerOnchain.update({
      where: { network_voter: { network, voter } },
      data: {
        successPrimary: Number.isFinite(sr.primary) ? sr.primary : null,
        successSecondary: Number.isFinite(sr.secondary) ? sr.secondary : null,
        successAvailability: Number.isFinite(sr.availability) ? sr.availability : null,
        successEpoch: sp.reward_epoch ?? epoch ?? null,
        successUpdatedAt: now,
        // Current-epoch weights. w_nat_weight is exactly what the explorer shows as DELEGATION WEIGHT.
        delegationWeight: weiString(sp.w_nat_weight),
        delegationWeightCapped: weiString(sp.w_nat_capped_weight),
        stakingWeight: weiString(sp.staking_weight),
      },
    });
    updated++;
  }
  console.log(
    `${network}: ${entities.length} entities from explorer (epoch ${epoch ?? "?"}), ` +
      `${updated} updated, ${noRate} without a success rate, ${missing} not in ProviderOnchain`
  );
  if (missing > 0) {
    console.log(
      `${network}: NOTE - ${missing} entities Flare knows about have no ProviderOnchain row. That is a ` +
        `gap in the fsp-rewards ingest, not in this job.`
    );
  }
}

async function main() {
  for (const net of ["flare", "songbird"]) await ingest(net);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
