// WHEN EACH PROVIDER FIRST APPEARED, from the block explorer.
//
// Records, per network, the timestamp of the earliest transaction a provider's DELEGATION address
// ever sent, which is as close to "joined" as the chain can answer.
//
// WHY THE DELEGATION ADDRESS. It is the one address that spans both FTSO eras: under FTSO v1 it WAS
// the data-provider address delegators pointed at, and it carried over into FSP. An entity's
// identity address, by contrast, is typically created at FSP registration, so a 2021 operator can
// show an identity address first used in 2026. Measured on a sample: identity addresses date almost
// every provider to 2025-2026, delegation addresses date them to 2021-09 (Songbird) and 2022-07
// (Flare), which are the two networks' FTSO launches.
//
// WHY NOT REWARD DATA, which we already hold. Flare publishes fsp-rewards only from Flare epoch 228
// (2024-09-26) and Songbird epoch 196 (2024-06-06). Taking the earliest epoch we hold would pin 45
// of 138 Flare providers and 71 of 95 Songbird providers to a single floor date, flattening the
// long-serving operators this is meant to distinguish into the same bucket as 2024 arrivals.
//
// WHAT IT IS NOT. A proxy, not a certificate. An address can be funded shortly before it goes live,
// so a provider's true first day may be a little later than its address's. It is displayed to the
// month, a granularity this comfortably supports.
//
// Safe to re-run: only fills rows that are still null unless --all is passed. Resumable, since each
// row is written as it is resolved rather than in one batch at the end.
//
//   node scripts/backfill-first-activity.mjs            # dry run, reports what it would write
//   node scripts/backfill-first-activity.mjs --apply
//   node scripts/backfill-first-activity.mjs --apply --all   # re-resolve rows already set
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const EXPLORER = {
  flare: "https://flare-explorer.flare.network",
  songbird: "https://songbird-explorer.flare.network",
};

const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");
// The explorer is a shared public service and this walks every provider, so it is paced rather than
// parallelised. At ~4 requests/second the whole backfill is a couple of minutes.
const GAP_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Earliest transaction timestamp for an address, or null if it has never sent one. */
async function firstTxAt(network, address, attempt = 0) {
  const url =
    `${EXPLORER[network]}/api?module=account&action=txlist` +
    `&address=${address}&sort=asc&page=1&offset=1`;
  try {
    const r = await fetch(url, { headers: { "user-agent": "flareregistry-backfill" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = await r.json();
    // status "0" is the explorer's "no transactions found", which is an answer, not a failure.
    const row = Array.isArray(b.result) ? b.result[0] : null;
    if (!row?.timeStamp) return null;
    return new Date(Number(row.timeStamp) * 1000);
  } catch (e) {
    // Transient: rate limiting and gateway blips both show up here. Back off and retry twice before
    // giving up on this address, so one blip does not leave a permanent hole in the column.
    if (attempt < 2) {
      await sleep(1000 * (attempt + 1));
      return firstTxAt(network, address, attempt + 1);
    }
    console.warn(`  ! ${network} ${address}: ${e.message}`);
    return undefined; // undefined = unresolved (retry next run); null = genuinely no transactions
  }
}

async function main() {
  const rows = await prisma.providerOnchain.findMany({
    where: ALL ? {} : { firstActivityAt: null },
    select: { id: true, network: true, voter: true, delegationAddress: true },
    orderBy: [{ network: "asc" }, { voter: "asc" }],
  });
  console.log(`${rows.length} row(s) to resolve${APPLY ? "" : "  (dry run, pass --apply to write)"}`);

  let written = 0,
    none = 0,
    failed = 0;
  for (const row of rows) {
    if (!EXPLORER[row.network]) continue;
    // Fall back to the identity address when an entity has no delegation address recorded. Less
    // accurate for veterans, but a date is better than a hole and the fallback is rare.
    const address = row.delegationAddress ?? row.voter;
    const at = await firstTxAt(row.network, address);
    if (at === undefined) {
      failed++;
    } else if (at === null) {
      none++;
    } else {
      written++;
      const month = at.toISOString().slice(0, 7);
      console.log(`  ${row.network.padEnd(8)} ${address} -> ${month}`);
      if (APPLY) {
        await prisma.providerOnchain.update({
          where: { id: row.id },
          data: { firstActivityAt: at },
        });
      }
    }
    await sleep(GAP_MS);
  }
  console.log(
    `\n${APPLY ? "written" : "would write"}: ${written}   no transactions: ${none}   unresolved: ${failed}`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
