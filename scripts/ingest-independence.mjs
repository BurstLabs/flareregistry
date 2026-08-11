// Mirror the implementation-independence screen from oracleindependence.com.
//
// WHY MIRRORED AND NOT FETCHED LIVE. A provider page must never fail to render because another site is
// down, and a reputation figure must not silently change shape mid-afternoon because a remote API
// blipped. This runs daily, writes what it got, and leaves the previous values in place if the fetch
// fails, so the worst case is stale data with a visible timestamp rather than a hole.
//
// WHY NOT THE COPIES ALREADY IN THIS DATABASE. flareregistry still holds ProviderSimilarity and
// ExternalDetection from before detection moved out, but both crons were disabled on 2 August and the
// rows are frozen at that date. Publishing a 10-day-old classification as current would be worse than
// not publishing one.
//
// WHAT THE SOURCE SAYS ABOUT ITSELF, carried here because the scoring depends on it:
//   "A suspicion score, not proof... it must never drive an automated determination about anyone."
//   "there are zero confirmed positives. The exclusions are the reliable half."
//   "The signal remains one-sided. A low lift is strong evidence against; a high lift is not evidence
//    for, because any median-of-prints implementation reads above the field whether or not it is the
//    reference code."
//
// The component built on this is therefore ASYMMETRIC: an exclusion earns credit because that half is
// reliable, and a candidate classification costs very little because that half is not. It also carries
// the smallest weight of any component.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SOURCE = process.env.INDEPENDENCE_URL ?? "https://oracleindependence.com/api/detection/full";
// Below this, assume a partial or broken payload and refuse to write. Same reasoning as the
// Management Group sync: a truncated answer must not be able to reclassify the whole field at once.
const MIN_ROWS = 40;

(async () => {
  let payload;
  try {
    const res = await fetch(SOURCE, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
  } catch (e) {
    // Leave the previous values standing. oiCheckedAt then shows its own age.
    console.error(`independence: fetch failed, keeping existing values: ${e.message ?? e}`);
    await prisma.$disconnect();
    return;
  }

  const rows = Array.isArray(payload?.report) ? payload.report : Object.values(payload?.report ?? {});
  if (rows.length < MIN_ROWS) {
    console.error(`independence: only ${rows.length} rows, below the ${MIN_ROWS} floor; refusing to write`);
    await prisma.$disconnect();
    return;
  }

  // The screen keys rows by the SUBMIT address (the reveal transaction sender), not the identity, so
  // resolve through all five on-chain roles. Matching on voter alone silently misses most of the field.
  const entities = await prisma.providerOnchain.findMany({
    where: { network: "flare" },
    select: {
      id: true, voter: true, delegationAddress: true, submitAddress: true,
      submitSignaturesAddress: true, signingPolicyAddress: true, oiClass: true,
    },
  });
  const byAddr = new Map();
  for (const e of entities) {
    for (const a of [e.voter, e.delegationAddress, e.submitAddress, e.submitSignaturesAddress, e.signingPolicyAddress]) {
      if (a) byAddr.set(a.toLowerCase(), e);
    }
  }

  const now = new Date();
  const counts = {};
  let written = 0, unmatched = 0, changed = 0;

  for (const r of rows) {
    const key = String(r?.voter ?? "").toLowerCase();
    const entity = byAddr.get(key);
    if (!entity) { unmatched++; continue; }
    const klass = typeof r.klass === "string" ? r.klass : null;
    const extP = typeof r?.external?.probability === "number" ? r.external.probability : null;
    counts[klass ?? "null"] = (counts[klass ?? "null"] ?? 0) + 1;
    if (entity.oiClass && entity.oiClass !== klass) changed++;
    await prisma.providerOnchain.update({
      where: { id: entity.id },
      data: { oiClass: klass, oiExternalP: extP, oiCheckedAt: now },
    });
    written++;
  }

  console.log(
    `independence: ${rows.length} rows from source, ${written} matched and written, ` +
    `${unmatched} unmatched, ${changed} class change(s)`
  );
  console.log(`  classes: ${JSON.stringify(counts)}`);
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error("ingest-independence failed:", e.message ?? e);
  await prisma.$disconnect();
  process.exit(1);
});
