// Cache a third party's PUBLISHED example-provider verdicts for cross-reference.
//
// Why this is worth having: their method shares no signals with ours. They compare cadence and value
// fingerprints against their own reference deployment; we use tick-grid lattices, per-cell hit patterns
// and a USDC config signature. Two independent methods agreeing is meaningful in a way that two of our
// own signals agreeing is not, and we hold zero confirmed positives, so external corroboration is the
// closest thing to ground truth available.
//
// Manners and fragility, both deliberate:
//   - Runs ONCE A DAY. Their payload is embedded in a large HTML document rather than served from an
//     API, so every fetch is expensive for them. Do not raise this frequency.
//   - Stores THEIR snapshot timestamp separately from our fetch time. Presenting a stale third-party
//     verdict as current would be worse than having no cross-reference.
//   - Admin-only downstream. This is their work; it is never published on any public surface of ours.
//
// The extraction is inherently brittle because it parses records out of a page. It fails loudly and
// changes nothing rather than writing partial data, so a layout change on their side leaves the last
// good snapshot in place instead of silently emptying the column.
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const SOURCE = "cerberusonchain";
const URL = process.env.EXTERNAL_DETECTION_URL ?? "https://cerberusonchain.xyz/";
// Anonymised labels carry no identity we can join on.
const ANON = /^Provider_\d+$/;

export const nameKey = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Pull every {"provider": ...} object out of the document by brace matching.
function extractRecords(html) {
  const out = new Map();
  const re = /\{"provider":"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    let depth = 0;
    for (let k = m.index; k < Math.min(html.length, m.index + 200000); k++) {
      const c = html[k];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            const rec = JSON.parse(html.slice(m.index, k + 1));
            if (rec.provider) out.set(rec.provider, rec);
          } catch { /* not a complete record; skip */ }
          break;
        }
      }
    }
  }
  return [...out.values()];
}

function snapshotDate(html) {
  // e.g. "generated 2026-08-01 18:07 UTC"
  const m = html.match(/generated\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/i);
  return m ? new Date(`${m[1]}T${m[2]}:00Z`) : null;
}

async function main() {
  const res = await fetch(URL, {
    headers: { "user-agent": "flareregistry-crossref/1.0 (+https://flareregistry.com)" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${URL}`);
  const html = await res.text();

  const records = extractRecords(html).filter((r) => !ANON.test(r.provider));
  // Refuse to write a suspiciously small harvest: a layout change should leave the previous snapshot
  // intact rather than blanking the column.
  const existing = await prisma.externalDetection.count({ where: { source: SOURCE } });
  if (records.length < 20 || (existing > 0 && records.length < existing * 0.5)) {
    throw new Error(
      `extracted only ${records.length} named records (previously ${existing}); refusing to overwrite`
    );
  }

  const snap = snapshotDate(html);
  let n = 0;
  for (const r of records) {
    const key = nameKey(r.provider);
    if (!key) continue;
    await prisma.externalDetection.upsert({
      where: { source_nameKey: { source: SOURCE, nameKey: key } },
      create: {
        source: SOURCE, name: r.provider, nameKey: key,
        probability: typeof r.p_example === "number" ? r.p_example : null,
        verdict: r.verdict ?? null, snapshotAt: snap,
      },
      update: {
        name: r.provider,
        probability: typeof r.p_example === "number" ? r.p_example : null,
        verdict: r.verdict ?? null, snapshotAt: snap,
      },
    });
    n++;
  }
  // Drop anyone they no longer publish, so the column cannot show a verdict they have retracted.
  const keep = records.map((r) => nameKey(r.provider));
  const gone = await prisma.externalDetection.deleteMany({
    where: { source: SOURCE, nameKey: { notIn: keep } },
  });
  console.log(
    `${SOURCE}: ${n} verdicts cached (snapshot ${snap ? snap.toISOString() : "unknown"})` +
      (gone.count ? `, ${gone.count} removed` : "")
  );
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
